/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Supports multiple credentials per provider with round-robin selection,
 * session-sticky hashing, and automatic rate-limit fallback.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@gsd/pi-ai";
import { getOAuthProvider, getOAuthProviders } from "@gsd/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../config.js";
import {
	formatActiveRateLimitSummary,
	formatProviderRecoverySummary,
	inspectAnthropicRateLimit,
	inspectOpenAICodexRateLimit,
	type CredentialRateLimitInfo,
} from "./rate-limit-inspector.js";
import { AUTH_LOCK_STALE_MS } from "./constants.js";
import { acquireLockAsync, acquireLockSyncWithRetry } from "./lock-utils.js";
import { resolveConfigValue } from "./resolve-config-value.js";

type AuthCredentialMetadata = {
	id?: string;
	label?: string;
	addedAt?: number;
	preferred?: boolean;
};

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
} & AuthCredentialMetadata;

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials & AuthCredentialMetadata;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export interface AuthCredentialStatus {
	id: string;
	label: string;
	type: AuthCredential["type"];
	isActive: boolean;
	isPreferred: boolean;
	isBackedOff: boolean;
	backoffRemainingMs: number;
}

export interface CredentialRecoveryWindow {
	credentialId: string;
	label: string;
	availableAt: number;
	waitMs: number;
}

/**
 * On-disk format: each provider maps to a single credential or an array of credentials.
 * Single credentials are normalized to arrays at load time for internal use.
 */
export type AuthStorageData = Record<string, AuthCredential | AuthCredential[]>;

type LockResult<T> = {
	result: T;
	next?: string;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await acquireLockAsync(this.authPath, {
				staleMs: AUTH_LOCK_STALE_MS,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

// ============================================================================
// Backoff durations for different error types (milliseconds)
// ============================================================================

const BACKOFF_RATE_LIMIT_MS = 30_000; // 30s for rate limit / 429
const BACKOFF_QUOTA_EXHAUSTED_MS = 30 * 60_000; // 30min for quota exhausted
const BACKOFF_SERVER_ERROR_MS = 20_000; // 20s for 5xx server errors
const BACKOFF_DEFAULT_MS = 60_000; // 60s fallback
const OAUTH_REFRESH_EARLY_MS = 60_000; // refresh shortly before expiry to avoid edge-of-expiry failures

export type UsageLimitErrorType = "rate_limit" | "quota_exhausted" | "server_error" | "unknown";

/**
 * Get backoff duration for an error type.
 */
function getBackoffDuration(errorType: UsageLimitErrorType): number {
	switch (errorType) {
		case "rate_limit":
			return BACKOFF_RATE_LIMIT_MS;
		case "quota_exhausted":
			return BACKOFF_QUOTA_EXHAUSTED_MS;
		case "server_error":
			return BACKOFF_SERVER_ERROR_MS;
		default:
			return BACKOFF_DEFAULT_MS;
	}
}

/**
 * Simple string hash for session-sticky credential selection.
 * Returns a positive integer.
 */
function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash);
}

function createCredentialId(): string {
	return `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert an array of credentials to the on-disk format (single value or array). */
function toStorageEntry(credentials: AuthCredential[]): AuthCredential | AuthCredential[] | undefined {
	if (credentials.length === 0) return undefined;
	return credentials.length === 1 ? credentials[0] : credentials;
}

function getStringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Credential storage backed by a JSON file.
 * Supports multiple credentials per provider with round-robin rotation and rate-limit fallback.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private activeCredentialIndex = new Map<string, number>();
	private activeCredentialIndexBySession = new Map<string, Map<string, number>>();
	private credentialChangeListeners: Set<() => void> = new Set();

	/**
	 * Round-robin index per provider. Incremented on each call to getApiKey
	 * when no sessionId is provided.
	 */
	private providerRoundRobinIndex: Map<string, number> = new Map();

	/**
	 * Backoff tracking per provider per credential index.
	 * Map<provider, Map<credentialIndex, backoffExpiresAt>>
	 */
	private credentialBackoff: Map<string, Map<number, number>> = new Map();

	/**
	 * Provider-level backoff tracking.
	 * Set when all credentials for a provider are backed off.
	 * Map<provider, backoffExpiresAt>
	 */
	private providerBackoff: Map<string, number> = new Map();

	/**
	 * Cached provider-specific rate-limit snapshots keyed by provider and credential id.
	 */
	private credentialRateLimitInfo = new Map<string, Map<string, CredentialRateLimitInfo>>();

	private constructor(private storage: AuthStorageBackend) {
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * Register a callback to be notified when credentials change (e.g., after OAuth token refresh).
	 * Returns a function to unregister the listener.
	 */
	onCredentialChange(listener: () => void): () => void {
		this.credentialChangeListeners.add(listener);
		return () => this.credentialChangeListeners.delete(listener);
	}

	private notifyCredentialChange(): void {
		for (const listener of this.credentialChangeListeners) {
			try {
				listener();
			} catch {
				// Don't let listener errors break the refresh flow
			}
		}
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	private normalizeCredential(
		provider: string,
		credential: AuthCredential,
		index: number,
	): { credential: AuthCredential; changed: boolean } {
		let changed = false;
		const normalized = { ...credential } as AuthCredential;
		if (normalized.type === "oauth") {
			const enriched = this.enrichOAuthCredentialFromToken(normalized);
			if (enriched !== normalized) {
				Object.assign(normalized, enriched);
				changed = true;
			}
		}
		if (!normalized.id) {
			normalized.id = createCredentialId();
			changed = true;
		}
		if (!normalized.addedAt) {
			normalized.addedAt = Date.now() + index;
			changed = true;
		}
		const desiredLabel = this.getDesiredCredentialLabel(normalized, index);
		if (!normalized.label || this.isGenericCredentialLabel(normalized)) {
			if (normalized.label !== desiredLabel) {
				normalized.label = desiredLabel;
				changed = true;
			}
		} else if (normalized.label !== normalized.label.trim()) {
			normalized.label = normalized.label.trim();
			changed = true;
		}
		return { credential: normalized, changed };
	}

	private enrichOAuthCredentialFromToken(credential: OAuthCredential): OAuthCredential {
		const accessPayload = decodeJwtPayload(credential.access);
		const idToken = getStringField((credential as OAuthCredential & { idToken?: unknown }).idToken);
		const idPayload = idToken ? decodeJwtPayload(idToken) : undefined;
		const payloads = [accessPayload, idPayload].filter((payload): payload is Record<string, unknown> => Boolean(payload));

		let accountId = getStringField((credential as OAuthCredential & { accountId?: unknown }).accountId);
		let email = getStringField((credential as OAuthCredential & { email?: unknown }).email);
		let displayName = getStringField((credential as OAuthCredential & { displayName?: unknown }).displayName);

		for (const payload of payloads) {
			accountId ||= getStringField(payload.accountId) || getStringField(payload.sub);
			email ||= getStringField(payload.email) || getStringField(payload.preferred_username) || getStringField(payload.upn);
			displayName ||= getStringField(payload.name);
		}

		if (!accountId && !email && !displayName) {
			return credential;
		}

		return {
			...credential,
			...(accountId ? { accountId } : {}),
			...(email ? { email } : {}),
			...(displayName ? { displayName } : {}),
		};
	}

	private isGenericCredentialLabel(credential: AuthCredential): boolean {
		const label = credential.label?.trim();
		if (!label) return true;
		if (credential.type === "oauth") {
			const accountId = getStringField((credential as OAuthCredential & { accountId?: unknown }).accountId);
			if (accountId && label === `Account ${accountId.slice(0, 8)}`) {
				return true;
			}
			return /^subscription\s+\d+$/i.test(label);
		}
		return /^api key\s+\d+$/i.test(label);
	}

	private getDesiredCredentialLabel(credential: AuthCredential, index: number): string {
		if (credential.type === "oauth") {
			const email = getStringField((credential as OAuthCredential & { email?: unknown }).email);
			if (email) return email;
			const displayName = getStringField((credential as OAuthCredential & { displayName?: unknown }).displayName);
			if (displayName) return displayName;
			const accountId = getStringField((credential as OAuthCredential & { accountId?: unknown }).accountId);
			if (accountId) return `Account ${accountId.slice(0, 8)}`;
			return `Subscription ${index + 1}`;
		}
		return `API key ${index + 1}`;
	}

	private getOAuthCredentialIdentityKey(credential: OAuthCredential): string | undefined {
		const accountId = getStringField((credential as OAuthCredential & { accountId?: unknown }).accountId);
		const email = getStringField((credential as OAuthCredential & { email?: unknown }).email);
		if (email && accountId) {
			return `email:${email.toLowerCase()}|account:${accountId}`;
		}
		if (email) {
			return `email:${email.toLowerCase()}`;
		}
		return undefined;
	}

	private findMatchingOAuthCredentialIndex(credentials: AuthCredential[], credential: OAuthCredential): number {
		const identityKey = this.getOAuthCredentialIdentityKey(credential);
		if (identityKey) {
			const byIdentity = credentials.findIndex(
				(existing) => existing.type === "oauth" && this.getOAuthCredentialIdentityKey(existing) === identityKey,
			);
			if (byIdentity >= 0) return byIdentity;
		}
		return credentials.findIndex(
			(existing) => existing.type === "oauth" && existing.access === credential.access && existing.refresh === credential.refresh,
		);
	}

	private mergeOAuthCredential(existing: OAuthCredential, incoming: OAuthCredential, index: number): OAuthCredential {
		const merged = {
			...existing,
			...incoming,
			id: existing.id,
			addedAt: existing.addedAt,
			preferred: incoming.preferred ?? existing.preferred,
		} satisfies OAuthCredential;
		return this.normalizeCredential("", merged, index).credential as OAuthCredential;
	}

	private normalizeProviderEntry(
		provider: string,
		entry: AuthCredential | AuthCredential[] | undefined,
	): {
		credentials: AuthCredential[];
		entry: AuthCredential | AuthCredential[] | undefined;
		changed: boolean;
	} {
		if (!entry) {
			return { credentials: [], entry: undefined, changed: false };
		}

		const rawCredentials = Array.isArray(entry) ? entry : [entry];
		let changed = false;
		const credentials = rawCredentials.map((credential, index) => {
			const normalized = this.normalizeCredential(provider, credential, index);
			changed = changed || normalized.changed;
			return normalized.credential;
		});

		return {
			credentials,
			entry: toStorageEntry(credentials),
			changed,
		};
	}

	private clearSelectionState(provider: string): void {
		this.activeCredentialIndex.delete(provider);
		this.activeCredentialIndexBySession.delete(provider);
	}

	private getStoredPreferredCredentialIndex(provider: string): number | undefined {
		const credentials = this.getCredentialsForProvider(provider);
		const index = credentials.findIndex((credential) => credential.preferred === true);
		return index >= 0 ? index : undefined;
	}

	private setActiveCredentialIndex(provider: string, index: number, sessionId?: string): void {
		if (sessionId) {
			let bySession = this.activeCredentialIndexBySession.get(provider);
			if (!bySession) {
				bySession = new Map();
				this.activeCredentialIndexBySession.set(provider, bySession);
			}
			bySession.set(sessionId, index);
			return;
		}
		this.activeCredentialIndex.set(provider, index);
	}

	private getActiveCredentialIndex(provider: string, sessionId?: string): number | undefined {
		if (sessionId) {
			return this.activeCredentialIndexBySession.get(provider)?.get(sessionId);
		}
		return this.activeCredentialIndex.get(provider);
	}

	private getCredentialBackoffRemaining(provider: string, index: number): number {
		const providerBackoff = this.credentialBackoff.get(provider);
		if (!providerBackoff) return 0;
		const expiresAt = providerBackoff.get(index);
		if (expiresAt === undefined) return 0;
		const remaining = expiresAt - Date.now();
		if (remaining <= 0) {
			providerBackoff.delete(index);
			return 0;
		}
		return remaining;
	}

	private getCredentialSelectionUrgency(
		provider: string,
		credential: AuthCredential,
	): { earliestResetAt: number; utilization: number } | undefined {
		if (!credential.id) return undefined;
		const snapshot = this.credentialRateLimitInfo.get(provider)?.get(credential.id);
		if (!snapshot || snapshot.error || snapshot.isRateLimited) return undefined;

		const now = Date.now();
		const candidateWindows = [snapshot.fiveHour, snapshot.weekly]
			.flatMap((window) => {
				if (!window || typeof window.resetsAt !== "number" || window.resetsAt <= now) {
					return [];
				}
				if (window.utilization != null && window.utilization >= 100) {
					return [];
				}
				return [{
					resetsAt: window.resetsAt,
					utilization: window.utilization ?? null,
				}];
			})
			.sort((left, right) => {
				if (left.resetsAt !== right.resetsAt) return left.resetsAt - right.resetsAt;
				return (left.utilization ?? Number.POSITIVE_INFINITY) - (right.utilization ?? Number.POSITIVE_INFINITY);
			});

		const earliest = candidateWindows[0];
		if (!earliest) return undefined;
		return {
			earliestResetAt: earliest.resetsAt,
			utilization: earliest.utilization ?? Number.POSITIVE_INFINITY,
		};
	}

	private getPreferredCredentialIndex(provider: string, sessionId?: string): number {
		const credentials = this.getCredentialsForProvider(provider);
		if (credentials.length === 0) return -1;
		const activeIndex = this.getActiveCredentialIndex(provider, sessionId);
		if (activeIndex !== undefined && activeIndex < credentials.length) {
			return activeIndex;
		}
		const storedPreferredIndex = this.getStoredPreferredCredentialIndex(provider);
		if (storedPreferredIndex !== undefined && !this.isCredentialBackedOff(provider, storedPreferredIndex)) {
			return storedPreferredIndex;
		}
		return this.selectCredentialIndex(provider, credentials, sessionId, { incrementRoundRobin: false });
	}

	private getCredentialIndexForRequest(
		provider: string,
		credentials: AuthCredential[],
		sessionId?: string,
	): number {
		const activeIndex = this.getActiveCredentialIndex(provider, sessionId);
		if (activeIndex !== undefined && activeIndex < credentials.length && !this.isCredentialBackedOff(provider, activeIndex)) {
			return activeIndex;
		}

		const storedPreferredIndex = this.getStoredPreferredCredentialIndex(provider);
		if (
			storedPreferredIndex !== undefined &&
			storedPreferredIndex < credentials.length &&
			!this.isCredentialBackedOff(provider, storedPreferredIndex)
		) {
			return storedPreferredIndex;
		}

		return this.selectCredentialIndex(provider, credentials, sessionId);
	}

	/**
	 * Normalize a storage entry to an array of credentials.
	 * Handles both single credential (backward compat) and array formats.
	 */
	getCredentialsForProvider(provider: string): AuthCredential[] {
		const normalized = this.normalizeProviderEntry(provider, this.data[provider]);
		if (normalized.changed) {
			this.data[provider] = normalized.entry!;
		}
		return normalized.credentials;
	}

	hasOAuth(provider: string): boolean {
		return this.getCredentialsForProvider(provider).some((credential) => credential.type === "oauth");
	}

	getPrimaryOAuthCredential(provider: string): OAuthCredential | undefined {
		const preferred = this.getSelectedCredential(provider);
		if (preferred?.type === "oauth") {
			return preferred;
		}
		const credential = this.getCredentialsForProvider(provider).find((entry) => entry.type === "oauth");
		return credential?.type === "oauth" ? credential : undefined;
	}

	getSelectedCredential(provider: string, sessionId?: string): AuthCredential | undefined {
		const credentials = this.getCredentialsForProvider(provider);
		const index = this.getPreferredCredentialIndex(provider, sessionId);
		if (index < 0 || index >= credentials.length) return undefined;
		return credentials[index];
	}

	getCredentialPool(provider: string, sessionId?: string): AuthCredentialStatus[] {
		const credentials = this.getCredentialsForProvider(provider);
		const activeIndex = this.getPreferredCredentialIndex(provider, sessionId);
		return credentials.map((credential, index) => {
			const backoffRemainingMs = this.getCredentialBackoffRemaining(provider, index);
			return {
				id: credential.id!,
				label: credential.label || `${credential.type === "oauth" ? "Subscription" : "API key"} ${index + 1}`,
				type: credential.type,
				isActive: index === activeIndex,
				isPreferred: credential.preferred === true,
				isBackedOff: backoffRemainingMs > 0,
				backoffRemainingMs,
			};
		});
	}

	getProviderRateLimitInfo(provider: string, sessionId?: string): CredentialRateLimitInfo[] {
		const cached = this.credentialRateLimitInfo.get(provider);
		if (!cached) return [];
		const pool = this.getCredentialPool(provider, sessionId);
		const result: CredentialRateLimitInfo[] = [];
		for (const credential of pool) {
			const info = cached.get(credential.id);
			if (!info) continue;
			result.push({
				...info,
				isActive: credential.isActive,
				isPreferred: credential.isPreferred,
				isBackedOff: credential.isBackedOff,
				backoffRemainingMs: credential.backoffRemainingMs,
			});
		}
		return result;
	}

	formatActiveCredentialRateLimitSummary(provider: string, sessionId?: string): string | undefined {
		const activeInfo = this.getProviderRateLimitInfo(provider, sessionId).find((info) => info.isActive);
		return formatActiveRateLimitSummary(activeInfo);
	}

	formatProviderRecoverySummary(provider: string, sessionId?: string): string | undefined {
		return formatProviderRecoverySummary(provider, this.getProviderRateLimitInfo(provider, sessionId));
	}

	getEarliestCredentialRecovery(provider: string, sessionId?: string): CredentialRecoveryWindow | undefined {
		const now = Date.now();
		const candidates = this.getProviderRateLimitInfo(provider, sessionId)
			.map((info) => {
				if (typeof info.availableAt === "number" && info.availableAt > now) {
					return {
						credentialId: info.credentialId,
						label: info.label,
						availableAt: info.availableAt,
						waitMs: Math.max(1000, info.availableAt - now),
					};
				}
				if ((info.backoffRemainingMs ?? 0) > 0) {
					return {
						credentialId: info.credentialId,
						label: info.label,
						availableAt: now + (info.backoffRemainingMs ?? 0),
						waitMs: info.backoffRemainingMs ?? 0,
					};
				}
				return undefined;
			})
			.filter((candidate): candidate is CredentialRecoveryWindow => Boolean(candidate))
			.sort((left, right) => left.availableAt - right.availableAt);
		return candidates[0];
	}

	async refreshProviderRateLimitInfo(provider: string, sessionId?: string): Promise<CredentialRateLimitInfo[]> {
		if (provider !== "anthropic" && provider !== "openai-codex") {
			this.credentialRateLimitInfo.delete(provider);
			return [];
		}

		const credentials = this.getCredentialsForProvider(provider);
		const snapshots = await Promise.all(
			credentials.map(async (credential, index) => {
				const label = credential.label || `${credential.type === "oauth" ? "Subscription" : "API key"} ${index + 1}`;
				if (credential.type !== "oauth" || !credential.id) {
					return {
						credentialId: credential.id || `unknown-${index}`,
						provider,
						label,
						fetchedAt: Date.now(),
						fiveHour: null,
						weekly: null,
						isRateLimited: false,
						availableAt: null,
						error: "Rate limit inspection is only available for OAuth credentials",
					} satisfies CredentialRateLimitInfo;
				}

				try {
					const resolvedAccess = await this.resolveCredentialApiKey(provider, credential);
					const latestCredential = this
						.getCredentialsForProvider(provider)
						.find((entry) => entry.id === credential.id && entry.type === "oauth");
					const oauthCredential = latestCredential?.type === "oauth" ? latestCredential : credential;
					const access = resolvedAccess ?? oauthCredential.access;
					if (!access) {
						throw new Error("OAuth access token unavailable for rate limit inspection");
					}

					if (provider === "anthropic") {
						return await inspectAnthropicRateLimit(provider, credential.id, label, access);
					}

					return await inspectOpenAICodexRateLimit(provider, credential.id, label, {
						access,
						refresh: oauthCredential.refresh,
						accountId: typeof (oauthCredential as AuthCredential & { accountId?: string }).accountId === "string"
							? (oauthCredential as AuthCredential & { accountId?: string }).accountId
							: undefined,
						idToken: typeof (oauthCredential as AuthCredential & { idToken?: string }).idToken === "string"
							? (oauthCredential as AuthCredential & { idToken?: string }).idToken
							: undefined,
					});
				} catch (error) {
					return {
						credentialId: credential.id,
						provider,
						label,
						fetchedAt: Date.now(),
						fiveHour: null,
						weekly: null,
						isRateLimited: false,
						availableAt: null,
						error: error instanceof Error ? error.message : String(error),
					} satisfies CredentialRateLimitInfo;
				}
			}),
		);

		const snapshotMap = new Map<string, CredentialRateLimitInfo>();
		for (const snapshot of snapshots) {
			snapshotMap.set(snapshot.credentialId, snapshot);
		}
		this.credentialRateLimitInfo.set(provider, snapshotMap);

		let providerBackoff = this.credentialBackoff.get(provider);
		if (!providerBackoff) {
			providerBackoff = new Map();
			this.credentialBackoff.set(provider, providerBackoff);
		}
		const now = Date.now();
		credentials.forEach((credential, index) => {
			const snapshot = credential.id ? snapshotMap.get(credential.id) : undefined;
			if (!snapshot) return;
			if (snapshot.isRateLimited && snapshot.availableAt && snapshot.availableAt > now) {
				providerBackoff.set(index, snapshot.availableAt);
				return;
			}
			if (!snapshot.isRateLimited) {
				providerBackoff.delete(index);
			}
		});

		return this.getProviderRateLimitInfo(provider, sessionId);
	}

	setPreferredCredential(provider: string, credentialId: string): AuthCredential | undefined {
		const credentials = this.getCredentialsForProvider(provider);
		const preferredIndex = credentials.findIndex((credential) => credential.id === credentialId);
		if (preferredIndex === -1) return undefined;

		const updated = credentials.map((credential, index) => ({
			...credential,
			preferred: index === preferredIndex,
		}));

		this.data[provider] = toStorageEntry(updated)!;
		this.activeCredentialIndexBySession.delete(provider);
		this.setActiveCredentialIndex(provider, preferredIndex);
		this.persistProviderChange(provider, this.data[provider]);
		return updated[preferredIndex];
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			const parsed = this.parseStorageData(content);
			const normalized: AuthStorageData = {};
			for (const [provider, entry] of Object.entries(parsed)) {
				normalized[provider] = this.normalizeProviderEntry(provider, entry).entry!;
			}
			this.data = normalized;
			this.credentialRateLimitInfo.clear();
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | AuthCredential[] | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			const normalizedCredential = this.normalizeProviderEntry(provider, credential).entry;
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (normalizedCredential) {
					merged[provider] = normalizedCredential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get the first credential for a provider (backward-compatible).
	 */
	get(provider: string): AuthCredential | undefined {
		const creds = this.getCredentialsForProvider(provider);
		return creds[0] ?? undefined;
	}

	/**
	 * Set credential for a provider. For API key credentials, appends to
	 * existing credentials (accumulation on duplicate login). For OAuth,
	 * replaces (only one OAuth token per provider makes sense).
	 */
	set(provider: string, credential: AuthCredential): void {
		const existing = this.getCredentialsForProvider(provider);
		if (credential.type === "api_key") {
			const normalizedCredential = this.normalizeCredential(
				provider,
				credential,
				existing.length,
			).credential;
			// Deduplicate: don't add if same key already exists
			const isDuplicate = existing.some(
				(c) => c.type === "api_key" && c.key === credential.key,
			);
			if (isDuplicate) return;

			const updated = [...existing, normalizedCredential];
			this.data[provider] = toStorageEntry(updated)!;
			this.credentialRateLimitInfo.delete(provider);
			this.persistProviderChange(provider, this.data[provider]);
		} else {
			const normalizedCredential = this.normalizeCredential(
				provider,
				credential,
				existing.length,
			).credential;
			const oauthCredential = normalizedCredential.type === "oauth" ? normalizedCredential : undefined;
			if (!oauthCredential) return;

			const matchingIndex = this.findMatchingOAuthCredentialIndex(existing, oauthCredential);
			if (matchingIndex >= 0) {
				const current = existing[matchingIndex];
				if (current?.type !== "oauth") return;
				const merged = this.mergeOAuthCredential(current, oauthCredential, matchingIndex);
				const updated = existing.map((entry, index) => (index === matchingIndex ? merged : entry));
				this.data[provider] = toStorageEntry(updated)!;
				this.credentialRateLimitInfo.delete(provider);
				this.persistProviderChange(provider, this.data[provider]);
				return;
			}

			const updated = [...existing, oauthCredential];
			this.data[provider] = toStorageEntry(updated)!;
			this.credentialRateLimitInfo.delete(provider);
			this.persistProviderChange(provider, this.data[provider]);
		}
	}

	removeCredential(provider: string, credentialId: string): AuthCredential | undefined {
		const credentials = this.getCredentialsForProvider(provider);
		const removed = credentials.find((credential) => credential.id === credentialId);
		if (!removed) return undefined;

		const remaining = credentials.filter((credential) => credential.id !== credentialId);
		this.clearSelectionState(provider);
		this.credentialBackoff.delete(provider);
		this.providerBackoff.delete(provider);
		this.credentialRateLimitInfo.delete(provider);

		if (remaining.length === 0) {
			this.remove(provider);
			return removed;
		}

		this.data[provider] = toStorageEntry(remaining)!;
		this.persistProviderChange(provider, this.data[provider]);
		return removed;
	}

	/**
	 * Remove all credentials for a provider.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.providerRoundRobinIndex.delete(provider);
		this.credentialBackoff.delete(provider);
		this.providerBackoff.delete(provider);
		this.credentialRateLimitInfo.delete(provider);
		this.clearSelectionState(provider);
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 * Returns normalized format where each provider has a single credential
	 * (the first one) for backward compatibility with OAuth refresh.
	 *
	 * NOTE: For providers with multiple API keys, only the first credential is
	 * returned. This is intentional — callers use this for OAuth refresh only,
	 * which is always single-credential. Do not use for API key enumeration.
	 */
	getAll(): Record<string, AuthCredential> {
		const result: Record<string, AuthCredential> = {};
		for (const [provider, entry] of Object.entries(this.data)) {
			result[provider] = Array.isArray(entry) ? entry[0] : entry;
		}
		return result;
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Returns true when the provider has credentials configured but all of them
	 * are currently in a backoff window (e.g. rate-limited or quota exhausted).
	 * Returns false when there are no credentials or at least one is available.
	 */
	areAllCredentialsBackedOff(provider: string): boolean {
		const credentials = this.getCredentialsForProvider(provider);
		if (credentials.length === 0) return false;
		for (let i = 0; i < credentials.length; i++) {
			if (!this.isCredentialBackedOff(provider, i)) return false;
		}
		return true;
	}

	/**
	 * Mark an entire provider as exhausted.
	 * Called when all credentials for a provider are backed off.
	 */
	markProviderExhausted(provider: string, errorType: UsageLimitErrorType): void {
		const backoffMs = getBackoffDuration(errorType);
		this.providerBackoff.set(provider, Date.now() + backoffMs);
	}

	/**
	 * Check if a provider is currently available (not backed off at provider level).
	 */
	isProviderAvailable(provider: string): boolean {
		const expiresAt = this.providerBackoff.get(provider);
		if (expiresAt === undefined) return true;
		if (Date.now() >= expiresAt) {
			this.providerBackoff.delete(provider);
			return true;
		}
		return false;
	}

	/**
	 * Get milliseconds remaining until provider backoff expires.
	 * Returns 0 if provider is available.
	 */
	getProviderBackoffRemaining(provider: string): number {
		const expiresAt = this.providerBackoff.get(provider);
		if (expiresAt === undefined) return 0;
		const remaining = expiresAt - Date.now();
		if (remaining <= 0) {
			this.providerBackoff.delete(provider);
			return 0;
		}
		return remaining;
	}

	/**
	 * Check if a credential index is currently backed off.
	 */
	private isCredentialBackedOff(provider: string, index: number): boolean {
		const providerBackoff = this.credentialBackoff.get(provider);
		if (!providerBackoff) return false;
		const expiresAt = providerBackoff.get(index);
		if (expiresAt === undefined) return false;
		if (Date.now() >= expiresAt) {
			providerBackoff.delete(index);
			return false;
		}
		return true;
	}

	/**
	 * Select the best credential index for a provider.
	 * - If sessionId is provided, uses session-sticky hashing as the starting point.
	 * - Otherwise, uses round-robin as the starting point.
	 * - Skips credentials that are currently backed off.
	 * - Returns -1 if all credentials are backed off.
	 */
	private selectCredentialIndex(
		provider: string,
		credentials: AuthCredential[],
		sessionId?: string,
		options?: { incrementRoundRobin?: boolean },
	): number {
		if (credentials.length === 0) return -1;
		if (credentials.length === 1) {
			return this.isCredentialBackedOff(provider, 0) ? -1 : 0;
		}

		let startIndex: number;
		if (sessionId) {
			startIndex = hashString(sessionId) % credentials.length;
		} else {
			const current = this.providerRoundRobinIndex.get(provider) ?? 0;
			startIndex = current % credentials.length;
			if (options?.incrementRoundRobin !== false) {
				this.providerRoundRobinIndex.set(provider, current + 1);
			}
		}

		// Collect candidates in the legacy wrap order first so round-robin/session
		// stickiness still acts as the tie-breaker when urgency is equal.
		const candidateIndexes: number[] = [];
		for (let offset = 0; offset < credentials.length; offset++) {
			const index = (startIndex + offset) % credentials.length;
			if (!this.isCredentialBackedOff(provider, index)) {
				candidateIndexes.push(index);
			}
		}

		if (candidateIndexes.length === 0) {
			return -1;
		}

		let bestIndex = candidateIndexes[0];
		let bestUrgency = this.getCredentialSelectionUrgency(provider, credentials[bestIndex]);
		for (let i = 1; i < candidateIndexes.length; i++) {
			const candidateIndex = candidateIndexes[i];
			const candidateUrgency = this.getCredentialSelectionUrgency(provider, credentials[candidateIndex]);

			if (!bestUrgency && candidateUrgency) {
				bestIndex = candidateIndex;
				bestUrgency = candidateUrgency;
				continue;
			}
			if (!bestUrgency || !candidateUrgency) {
				continue;
			}
			if (candidateUrgency.earliestResetAt < bestUrgency.earliestResetAt) {
				bestIndex = candidateIndex;
				bestUrgency = candidateUrgency;
				continue;
			}
			if (
				candidateUrgency.earliestResetAt === bestUrgency.earliestResetAt
				&& candidateUrgency.utilization < bestUrgency.utilization
			) {
				bestIndex = candidateIndex;
				bestUrgency = candidateUrgency;
			}
		}

		return bestIndex;

	}

	/**
	 * Mark a credential as rate-limited. Finds the credential that was most
	 * recently used for this provider+session and backs it off.
	 *
	 * @returns true if another credential is available (caller should retry),
	 *          false if all credentials for this provider are backed off.
	 */
	markUsageLimitReached(
		provider: string,
		sessionId?: string,
		options?: { errorType?: UsageLimitErrorType },
	): boolean {
		return this.markUsageLimitReachedWithFallback(provider, sessionId, options).hasAlternate;
	}

	markUsageLimitReachedWithFallback(
		provider: string,
		sessionId?: string,
		options?: { errorType?: UsageLimitErrorType },
	): {
		usedCredential?: AuthCredential;
		nextCredential?: AuthCredential;
		hasAlternate: boolean;
	} {
		const credentials = this.getCredentialsForProvider(provider);
		if (credentials.length === 0) return { hasAlternate: false };

		const errorType = options?.errorType ?? "rate_limit";

		// For unknown/transport errors (e.g. connection reset, "terminated"),
		// don't back off the only credential — it would make getApiKey() return
		// undefined and surface a misleading "Authentication failed" message.
		if (errorType === "unknown" && credentials.length === 1) {
			return { hasAlternate: false, usedCredential: credentials[0] };
		}

		const backoffMs = getBackoffDuration(errorType);

		// Determine which credential was just used (same logic as selectCredentialIndex
		// but without incrementing round-robin)
		let usedIndex: number;
		if (credentials.length === 1) {
			usedIndex = 0;
		} else if (sessionId) {
			usedIndex = this.getActiveCredentialIndex(provider, sessionId) ?? (hashString(sessionId) % credentials.length);
		} else {
			const activeIndex = this.getActiveCredentialIndex(provider);
			if (activeIndex !== undefined && activeIndex < credentials.length) {
				usedIndex = activeIndex;
			} else {
				// Round-robin was already incremented in getApiKey, so the last-used
				// index is (current - 1). Note: in a concurrent scenario where another
				// getApiKey call fires between the original request and this backoff call,
				// we may back off the wrong credential index. This is acceptable because:
				// (a) pi runs single-threaded event loop, (b) backing off the wrong key
				// is safe — it self-heals when the backoff expires.
				const current = this.providerRoundRobinIndex.get(provider) ?? 0;
				usedIndex = ((current - 1) % credentials.length + credentials.length) % credentials.length;
			}
		}

		// For quota exhaustion, multiple OAuth credentials can be aliases for the
		// same underlying ChatGPT/OpenAI account. Backing off only the exact
		// credential causes futile rotation within the same exhausted account pool.
		const usedCredential = credentials[usedIndex];
		const usedAccountId = errorType === "quota_exhausted" && usedCredential?.type === "oauth"
			? getStringField((usedCredential as OAuthCredential & { accountId?: unknown }).accountId)
			: undefined;

		const indexesToBackOff = usedAccountId
			? credentials
				.map((credential, index) => ({ credential, index }))
				.filter(
					({ credential }) => credential.type === "oauth"
						&& getStringField((credential as OAuthCredential & { accountId?: unknown }).accountId) === usedAccountId,
				)
				.map(({ index }) => index)
			: [usedIndex];

		// Set backoff for this credential (or the whole underlying account group)
		let providerBackoff = this.credentialBackoff.get(provider);
		if (!providerBackoff) {
			providerBackoff = new Map();
			this.credentialBackoff.set(provider, providerBackoff);
		}
		const backoffUntil = Date.now() + backoffMs;
		for (const index of indexesToBackOff) {
			providerBackoff.set(index, backoffUntil);
		}

		// Check if any credential is still available
		for (let i = 0; i < credentials.length; i++) {
			if (!this.isCredentialBackedOff(provider, i)) {
				this.setActiveCredentialIndex(provider, i, sessionId);
				return {
					hasAlternate: true,
					usedCredential,
					nextCredential: credentials[i],
				};
			}
		}
		return { hasAlternate: false, usedCredential };
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
		credentialId?: string,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			const normalized = this.normalizeProviderEntry(providerId, currentData[providerId]);
			if (normalized.entry) {
				currentData[providerId] = normalized.entry;
			}
			this.data = { ...this.data, ...currentData };
			this.loadError = null;

			// Find the OAuth credential for this provider
			const creds = this.getCredentialsForProvider(providerId);
			const cred = creds.find((c) => c.type === "oauth" && (!credentialId || c.id === credentialId));
			if (!cred || cred.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires - OAUTH_REFRESH_EARLY_MS) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			let refreshed: OAuthCredentials;
			try {
				refreshed = await provider.refreshToken(cred);
			} catch {
				throw new Error(`Failed to refresh OAuth token for ${providerId}`);
			}

			// Update the OAuth credential in-place within the array
			const existingEntry = currentData[providerId];
			const newOAuthCred: OAuthCredential = {
				...cred,
				type: "oauth",
				...refreshed,
			};
			let updatedEntry: AuthCredential | AuthCredential[];

			if (Array.isArray(existingEntry)) {
				updatedEntry = existingEntry.map((c) =>
					c.type === "oauth" && (!credentialId || c.id === credentialId) ? newOAuthCred : c,
				);
			} else {
				updatedEntry = newOAuthCred;
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: updatedEntry,
			};
			this.data = merged;
			this.loadError = null;
			return {
				result: {
					newCredentials: refreshed,
					apiKey: provider.getApiKey(refreshed),
				},
				next: JSON.stringify(merged, null, 2),
			};
		});

		// Notify listeners after credential change (e.g., model registry refresh)
		if (result) {
			queueMicrotask(() => this.notifyCredentialChange());
		}

		return result;
	}

	/**
	 * Resolve an API key from a single credential.
	 */
	private async resolveCredentialApiKey(
		providerId: string,
		cred: AuthCredential,
	): Promise<string | undefined> {
		if (cred.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) return undefined;

			const needsRefresh = Date.now() >= cred.expires - OAUTH_REFRESH_EARLY_MS;
			if (needsRefresh) {
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId, cred.id);
					if (result) return result.apiKey;
				} catch (error) {
					this.recordError(error);
					this.reload();
					const updatedCreds = this.getCredentialsForProvider(providerId);
					const updatedOAuth = updatedCreds.find((c) => c.type === "oauth" && c.id === cred.id);
					if (updatedOAuth?.type === "oauth" && Date.now() < updatedOAuth.expires) {
						return provider.getApiKey(updatedOAuth);
					}
					return undefined;
				}
			} else {
				return provider.getApiKey(cred);
			}
		}

		return undefined;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Credential(s) from auth.json (with round-robin / session-sticky selection)
	 * 3. Environment variable
	 * 4. Fallback resolver (models.json custom providers)
	 *
	 * @param providerId - The provider to get an API key for
	 * @param sessionId - Optional session ID for sticky credential selection
	 */
	async getApiKey(providerId: string, sessionId?: string, options?: { baseUrl?: string }): Promise<string | undefined> {
		// If the model has a local baseUrl, return a dummy key to avoid auth blocking
		if (options?.baseUrl) {
			try {
				const hostname = new URL(options.baseUrl).hostname;
				if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") {
					return "local-no-key-needed";
				}
			} catch {
				if (options.baseUrl.startsWith("unix:")) {
					return "local-no-key-needed";
				}
			}
		}

		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const credentials = this.getCredentialsForProvider(providerId);

		if (credentials.length > 0) {
			const index = this.getCredentialIndexForRequest(providerId, credentials, sessionId);
			if (index >= 0) {
				if (sessionId || this.getStoredPreferredCredentialIndex(providerId) !== undefined) {
					this.setActiveCredentialIndex(providerId, index, sessionId);
				}
				const resolved = await this.resolveCredentialApiKey(providerId, credentials[index]);
				if (resolved) return resolved;
				// Credential unresolvable (e.g. type:"oauth" for a non-OAuth provider) —
				// fall through to env / fallback instead of returning undefined (#2083)
			}
			// All credentials backed off or unresolvable - fall through to env/fallback
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.fallbackResolver?.(providerId) ?? undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
