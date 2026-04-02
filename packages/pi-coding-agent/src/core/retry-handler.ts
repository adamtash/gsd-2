/**
 * RetryHandler - Automatic retry logic with exponential backoff and credential/provider fallback.
 *
 * Handles retryable errors (overloaded, rate limit, server errors) by:
 * 1. Trying alternate credentials for the same provider
 * 2. Falling back to other providers via FallbackResolver
 * 3. Exponential backoff with configurable max retries
 *
 * Context overflow errors are NOT handled here (see compaction).
 */

import type { Agent } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";
import { isContextOverflow } from "@gsd/pi-ai";
import type { AuthStorage, UsageLimitErrorType } from "./auth-storage.js";
import { formatRelativeTime } from "./rate-limit-inspector.js";
import type { FallbackResolver } from "./fallback-resolver.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SettingsManager } from "./settings-manager.js";
import { sleep } from "../utils/sleep.js";
import type { AgentSessionEvent } from "./agent-session.js";

/** Dependencies injected from AgentSession into RetryHandler */
export interface RetryHandlerDeps {
	readonly agent: Agent;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	readonly fallbackResolver: FallbackResolver;
	readonly sleepFn?: typeof sleep;
	readonly now?: () => number;
	getModel: () => Model<any> | undefined;
	getSessionId: () => string;
	emit: (event: AgentSessionEvent) => void;
	/** Called when the retry handler switches to a fallback model */
	onModelChange: (model: Model<any>) => void;
}

export class RetryHandler {
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	/** Escalation counter for credential-wait backoff (reset on successful retry) */
	private _credentialWaitEscalation = 0;
	/** True while waiting for a provider/credential to recover from rate limits. */
	private _isInWaitLoop = false;

	constructor(private readonly _deps: RetryHandlerDeps) {}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this._deps.settingsManager.getRetryEnabled();
	}

	/** Toggle auto-retry setting */
	setAutoRetryEnabled(enabled: boolean): void {
		this._deps.settingsManager.setRetryEnabled(enabled);
	}

	/**
	 * Create a retry promise synchronously for agent_end events.
	 * Must be called synchronously from the agent event handler before
	 * any async processing, so that waitForRetry() doesn't miss in-flight retries.
	 */
	createRetryPromiseForAgentEnd(messages: Array<{ role: string } & Record<string, any>>): void {
		if (this._retryPromise) return;

		const settings = this._deps.settingsManager.getRetrySettings();
		if (!settings.enabled) return;

		const lastAssistant = this._findLastAssistantInMessages(messages);
		if (!lastAssistant || !this.isRetryableError(lastAssistant)) return;

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	/**
	 * Handle a successful assistant response by resetting retry state.
	 * Call this when an assistant message completes without error.
	 */
	handleSuccessfulResponse(): void {
		if (this._retryAttempt > 0 || this._isInWaitLoop) {
			this._deps.emit({
				type: "auto_retry_end",
				success: true,
				attempt: this._retryAttempt,
			});
			this._retryAttempt = 0;
			this._credentialWaitEscalation = 0;
			this._isInWaitLoop = false;
			this._resolveRetry();
		}
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this._deps.getModel()?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|temporarily backed off|extra usage is required/i.test(
			err,
		);
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * When multiple credentials are available, marks the failing credential
	 * as backed off and retries immediately with the next one.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const settings = this._deps.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._resolveRetry();
			return false;
		}

		// Retry promise is created synchronously in createRetryPromiseForAgentEnd.
		// Keep a defensive fallback here in case a future refactor bypasses that path.
		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		// Try credential fallback before counting against retry budget.
		if (this._deps.getModel() && message.errorMessage) {
			const currentModel = this._deps.getModel()!;
			const errorType = this._classifyErrorType(message.errorMessage);
			const isCredentialError = errorType === "rate_limit" || errorType === "quota_exhausted";

			// Skip markUsageLimitReached when all credentials are already backed off.
			// Calling it would escalate the backoff on an already-backed-off credential
			// (which made no actual API call). Check state directly instead of matching
			// the error message text from sdk.ts.
			const allAlreadyBackedOff = isCredentialError &&
				this._deps.modelRegistry.authStorage.areAllCredentialsBackedOff(currentModel.provider);

			const hasAlternate =
				isCredentialError &&
				!allAlreadyBackedOff &&
				this._deps.modelRegistry.authStorage.markUsageLimitReached(
					currentModel.provider,
					this._deps.getSessionId(),
					{ errorType, retryAfterMs: message.retryAfterMs },
				);

			if (hasAlternate) {
				this._removeLastAssistantError();

				this._deps.emit({
					type: "auto_retry_start",
					attempt: this._retryAttempt + 1,
					maxAttempts: settings.maxRetries,
					delayMs: 0,
					errorMessage: `${message.errorMessage} (switching credential)`,
				});

				// Retry immediately with the next credential - don't increment _retryAttempt
				setTimeout(() => {
					this._deps.agent.continue().catch(() => {});
				}, 0);

				return true;
			}

			if (isCredentialError) {
				// When the current provider is exhausted, always try cross-provider
				// fallback next. This must work even for single-credential providers,
				// otherwise the retry loop stalls on exponential backoff instead of
				// continuing through the provider pool.
				const fallbackResult = await this._deps.fallbackResolver.findFallback(
					currentModel,
					errorType,
				);

				if (fallbackResult) {
					this._deps.agent.setModel(fallbackResult.model);
					this._deps.onModelChange(fallbackResult.model);
					this._removeLastAssistantError();

					this._deps.emit({
						type: "fallback_provider_switch",
						from: `${currentModel.provider}/${currentModel.id}`,
						to: `${fallbackResult.model.provider}/${fallbackResult.model.id}`,
						reason: fallbackResult.reason,
					});

					this._deps.emit({
						type: "auto_retry_start",
						attempt: this._retryAttempt + 1,
						maxAttempts: settings.maxRetries,
						delayMs: 0,
						errorMessage: `${message.errorMessage} (${fallbackResult.reason})`,
					});

					// Retry immediately with fallback provider - don't increment _retryAttempt
					setTimeout(() => {
						this._deps.agent.continue().catch(() => {});
					}, 0);

					return true;
				}

				if (errorType === "quota_exhausted") {
					// Try long-context model downgrade ([1m] → base) before waiting
					const downgraded = this._tryLongContextDowngrade(message);
					if (downgraded) return true;
				}

				// No provider is available right now. Wait for the first provider in
				// the recovery set to come back instead of stopping after a fixed
				// number of attempts or only watching the current provider.
				this._isInWaitLoop = true;
				this._removeLastAssistantError();
				const recovered = await this._waitForProviderRecovery(currentModel);

				if (recovered) {
					if (recovered.provider !== currentModel.provider) {
						const recoveredModel = this._deps.fallbackResolver.resolveRecoveryModel(
							currentModel,
							recovered.provider,
						);
						if (recoveredModel) {
							this._deps.agent.setModel(recoveredModel);
							this._deps.onModelChange(recoveredModel);
							this._deps.emit({
								type: "fallback_provider_switch",
								from: `${currentModel.provider}/${currentModel.id}`,
								to: `${recoveredModel.provider}/${recoveredModel.id}`,
								reason: `provider recovered after wait: ${recovered.provider}`,
							});
						}
					}

					setTimeout(() => {
						this._deps.agent.continue().catch(() => {});
					}, 0);
					return true;
				}

				// Wait was cancelled (e.g. user pressed Escape)
				this._isInWaitLoop = false;
				this._credentialWaitEscalation = 0;
				this._resolveRetry();
				return false;
			}
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._deps.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._resolveRetry();
			return false;
		}

		// Use server-requested delay when available, capped by maxDelayMs.
		// Fall back to exponential backoff when no server hint is present.
		const exponentialDelayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
		let delayMs: number;
		if (message.retryAfterMs !== undefined) {
			// For credential errors we never cap — we always wait. For other errors
			// we still respect the configured maxDelayMs.
			const cap = settings.maxDelayMs > 0 ? settings.maxDelayMs : Infinity;
			if (message.retryAfterMs > cap) {
				this._deps.emit({
					type: "auto_retry_end",
					success: false,
					attempt: this._retryAttempt - 1,
					finalError: `Rate limit reset in ${Math.ceil(message.retryAfterMs / 1000)}s (max: ${Math.ceil(cap / 1000)}s). ${message.errorMessage || ""}`.trim(),
				});
				this._retryAttempt = 0;
				this._resolveRetry();
				return false;
			}
			delayMs = message.retryAfterMs;
		} else {
			delayMs = exponentialDelayMs;
		}

		this._deps.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		this._removeLastAssistantError();

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await this._sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._retryAbortController = undefined;
			this._deps.emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this._resolveRetry();
			return false;
		}
		this._retryAbortController = undefined;

		// Retry via continue() - use setTimeout to break out of event handler chain
		setTimeout(() => {
			this._deps.agent.continue().catch(() => {});
		}, 0);

		return true;
	}

	/** Cancel in-progress retry */
	abortRetry(): void {
		this._retryAbortController?.abort();
		this._resolveRetry();
	}

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	async waitForRetry(): Promise<void> {
		if (this._retryPromise) {
			await this._retryPromise;
		}
	}

	/** Resolve the pending retry promise */
	resolveRetry(): void {
		this._resolveRetry();
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return (this._deps.sleepFn ?? sleep)(ms, signal);
	}

	private _now(): number {
		return this._deps.now?.() ?? Date.now();
	}

	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
		}
	}

	private _findLastAssistantInMessages(
		messages: Array<{ role: string } & Record<string, any>>,
	): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Classify an error message into a usage-limit error type for credential backoff.
	 */
	private _classifyErrorType(errorMessage: string): UsageLimitErrorType {
		const err = errorMessage.toLowerCase();
		// Long-context entitlement errors are billing gates, not transient rate limits.
		// Must be checked before the generic 429/rate_limit regex.
		if (/extra usage is required|long context required/i.test(err)) return "quota_exhausted";
		if (/quota|billing|exceeded.*limit|usage.*limit/i.test(err)) return "quota_exhausted";
		if (/rate.?limit|too many requests|429/i.test(err)) return "rate_limit";
		if (/500|502|503|504|server.?error|internal.?error|service.?unavailable/i.test(err)) return "server_error";
		return "unknown";
	}

	/**
	 * Attempt to downgrade a long-context model (e.g. claude-opus-4-6[1m]) to its
	 * base model (claude-opus-4-6) when the account lacks the long-context billing
	 * entitlement. Returns true if the downgrade was initiated.
	 */
	private _tryLongContextDowngrade(message: AssistantMessage): boolean {
		const currentModel = this._deps.getModel();
		if (!currentModel) return false;

		// Only attempt downgrade for [1m] (or similar long-context) model IDs
		const match = currentModel.id.match(/^(.+)\[\d+m\]$/);
		if (!match) return false;

		const baseModelId = match[1];
		const baseModel = this._deps.modelRegistry.find(currentModel.provider, baseModelId);
		if (!baseModel) return false;

		const previousId = currentModel.id;
		this._deps.agent.setModel(baseModel);
		this._deps.onModelChange(baseModel);
		this._removeLastAssistantError();

		this._deps.emit({
			type: "fallback_provider_switch",
			from: `${currentModel.provider}/${previousId}`,
			to: `${baseModel.provider}/${baseModel.id}`,
			reason: `long context downgrade: ${previousId} → ${baseModel.id}`,
		});

		this._deps.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt + 1,
			maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
			delayMs: 0,
			errorMessage: `${message.errorMessage} (long context downgrade)`,
		});

		setTimeout(() => {
			this._deps.agent.continue().catch(() => {});
		}, 0);

		return true;
	}

	/** Remove the last assistant error message from agent state */
	private _removeLastAssistantError(): void {
		const messages = this._deps.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this._deps.agent.replaceMessages(messages.slice(0, -1));
		}
	}

	/**
	 * Build a human-readable summary of all credentials for a provider,
	 * showing their status (available, backed off, rate-limited, etc.).
	 */
	private _buildCredentialSummary(provider: string): string[] {
		const authStorage = this._deps.modelRegistry.authStorage;
		const pool = authStorage.getCredentialPool(provider, this._deps.getSessionId());
		const rateLimitInfos = authStorage.getProviderRateLimitInfo(provider, this._deps.getSessionId());
		const rateLimitMap = new Map(rateLimitInfos.map((info) => [info.credentialId, info]));
		const now = this._now();

		return pool.map((cred) => {
			const parts: string[] = [];
			const tag = cred.isActive ? "▸" : " ";
			parts.push(`${tag} ${cred.label}`);

			const rlInfo = rateLimitMap.get(cred.id);
			if (rlInfo?.isRateLimited) {
				// Show both relative ("in 2h 15m") and absolute ("at 17:30") for blocked accounts
				const windows: string[] = [];
				if (rlInfo.fiveHour?.utilization != null) {
					const resetAt = rlInfo.fiveHour.resetsAt
						? ` → resets ${_formatAbsoluteTime(rlInfo.fiveHour.resetsAt)}`
						: "";
					windows.push(`5h: ${Math.round(rlInfo.fiveHour.utilization)}%${resetAt}`);
				}
				if (rlInfo.weekly?.utilization != null) {
					const resetAt = rlInfo.weekly.resetsAt
						? ` → resets ${_formatAbsoluteTime(rlInfo.weekly.resetsAt)}`
						: "";
					windows.push(`7d: ${Math.round(rlInfo.weekly.utilization)}%${resetAt}`);
				}
				if (rlInfo.availableAt) {
					parts.push(`BLOCKED — available ${formatRelativeTime(rlInfo.availableAt, now)} (${_formatAbsoluteTime(rlInfo.availableAt)})`);
				} else {
					parts.push("BLOCKED — reset time unknown");
				}
				if (windows.length > 0) parts.push(windows.join(", "));
			} else if (cred.isBackedOff) {
				const backoffUntil = now + cred.backoffRemainingMs;
				parts.push(`backed off — available ${formatRelativeTime(backoffUntil, now)} (${_formatAbsoluteTime(backoffUntil)})`);
			} else if (rlInfo?.error) {
				// API keys can't be probed — show that clearly instead of "unknown"
				parts.push(cred.type === "api_key" ? "API key (usage not inspectable)" : "status unknown");
			} else {
				parts.push("✓ available");
				if (rlInfo?.fiveHour?.utilization != null) {
					parts.push(`5h: ${Math.round(rlInfo.fiveHour.utilization)}%`);
				}
			}

			return parts.join(" — ");
		});
	}

	private _buildRecoverySummary(providers: string[]): string[] {
		const authStorage = this._deps.modelRegistry.authStorage;
		const now = this._now();
		const lines: string[] = [];

		for (const provider of providers) {
			const summary = this._buildCredentialSummary(provider);
			if (summary.length > 0) {
				lines.push(...summary.map((line) => `[${provider}] ${line}`));
				continue;
			}

			const providerBackoffMs = authStorage.getProviderBackoffRemaining(provider);
			if (providerBackoffMs > 0) {
				const availableAt = now + providerBackoffMs;
				lines.push(
					`[${provider}] provider backed off — available ${formatRelativeTime(availableAt, now)} (${_formatAbsoluteTime(availableAt)})`,
				);
			}
		}

		return lines;
	}

	private async _refreshRecoveryCandidates(providers: string[]): Promise<void> {
		const authStorage = this._deps.modelRegistry.authStorage;
		for (const provider of providers) {
			try {
				await authStorage.refreshProviderRateLimitInfo(provider, this._deps.getSessionId());
			} catch {
				// Use cached or client-side backoff data when live probing fails.
			}
		}
	}

	private _canProviderServeRequests(currentModel: Model<any>, provider: string): boolean {
		const authStorage = this._deps.modelRegistry.authStorage;
		if (!authStorage.isProviderAvailable(provider)) return false;

		const recoveryModel = this._deps.fallbackResolver.resolveRecoveryModel(currentModel, provider);
		if (!recoveryModel) return false;
		if (!this._deps.modelRegistry.isProviderRequestReady(provider)) return false;
		if (!authStorage.hasAuth(provider)) return true;
		return !authStorage.areAllCredentialsBackedOff(provider);
	}

	private _findRecoveredProvider(
		currentModel: Model<any>,
		providers: string[],
	): { provider: string; resumeCredential?: string } | undefined {
		const authStorage = this._deps.modelRegistry.authStorage;
		for (const provider of providers) {
			if (!this._canProviderServeRequests(currentModel, provider)) continue;
			const availableCredential = authStorage
				.getCredentialPool(provider, this._deps.getSessionId())
				.find((credential) => !credential.isBackedOff);
			return {
				provider,
				resumeCredential: availableCredential?.label,
			};
		}
		return undefined;
	}

	private _getEarliestProviderRecovery(
		currentModel: Model<any>,
		providers: string[],
	): { provider: string; availableAt: number; waitMs: number } | undefined {
		const authStorage = this._deps.modelRegistry.authStorage;
		const now = this._now();
		let best: { provider: string; availableAt: number; waitMs: number } | undefined;

		for (const provider of providers) {
			const recoveryModel = this._deps.fallbackResolver.resolveRecoveryModel(currentModel, provider);
			if (!recoveryModel) continue;

			const providerWaitMs = authStorage.getProviderBackoffRemaining(provider);
			let credentialWaitMs = 0;
			if (authStorage.hasAuth(provider) && authStorage.areAllCredentialsBackedOff(provider)) {
				credentialWaitMs = authStorage.getEarliestCredentialRecovery(
					provider,
					this._deps.getSessionId(),
				)?.waitMs ?? 0;
			}

			const waitMs = Math.max(providerWaitMs, credentialWaitMs);
			if (waitMs <= 0) continue;

			const candidate = {
				provider,
				waitMs,
				availableAt: now + waitMs,
			};

			if (!best || candidate.availableAt < best.availableAt) {
				best = candidate;
			}
		}

		return best;
	}

	/**
	 * Wait for the first provider in the recovery set to become available.
	 *
	 * This keeps auto-retry alive across a whole fallback pool instead of only
	 * watching the current provider, and it intentionally does not impose a hard
	 * stop after N loops or a fixed total duration. Escape remains the manual
	 * stop mechanism.
	 */
	private async _waitForProviderRecovery(
		currentModel: Model<any>,
	): Promise<{ provider: string; resumeCredential?: string } | undefined> {
		const providers = this._deps.fallbackResolver.getRecoveryCandidateProviders(currentModel);
		this._retryAbortController = new AbortController();
		const signal = this._retryAbortController.signal;

		const TICK_INTERVAL_MS = 15_000; // 15s progress ticks
		const FALLBACK_WAIT_MS = 60_000; // when no provider exposes a concrete reset time

		await this._refreshRecoveryCandidates(providers);
		let startEmitted = false;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (signal.aborted) {
				this._retryAbortController = undefined;
				this._deps.emit({ type: "credential_wait_end", provider: currentModel.provider });
				return undefined;
			}

			const recovered = this._findRecoveredProvider(currentModel, providers);
			if (recovered) {
				this._retryAbortController = undefined;
				this._credentialWaitEscalation = 0;
				this._deps.emit({
					type: "credential_wait_end",
					provider: recovered.provider,
					resumeCredential: recovered.resumeCredential,
				});
				return recovered;
			}

			const recovery = this._getEarliestProviderRecovery(currentModel, providers);
			const credentialSummary = this._buildRecoverySummary(providers);

			let waitMs: number;
			let waitProvider: string;
			let targetTime: number;
			if (recovery) {
				waitMs = Math.max(recovery.availableAt - this._now() + 2_000, 5_000);
				waitProvider = recovery.provider;
				targetTime = this._now() + waitMs;
				this._credentialWaitEscalation = 0;
			} else {
				const escalated = Math.min(
					FALLBACK_WAIT_MS * 2 ** this._credentialWaitEscalation,
					10 * 60_000,
				);
				waitMs = escalated;
				waitProvider = currentModel.provider;
				targetTime = this._now() + waitMs;
				this._credentialWaitEscalation = Math.min(this._credentialWaitEscalation + 1, 5);
			}

			if (!startEmitted) {
				this._deps.emit({
					type: "credential_wait_start",
					provider: waitProvider,
					waitMs,
					availableAt: targetTime,
					credentialSummary,
					reason: `All configured providers are temporarily unavailable. Next retry target: ${waitProvider} at ${_formatAbsoluteTime(targetTime)}.`,
				});
				startEmitted = true;
			}

			const sleepUntil = this._now() + waitMs;
			while (this._now() < sleepUntil) {
				if (signal.aborted) break;

				const remainingMs = Math.max(0, sleepUntil - this._now());
				const tickMs = Math.min(TICK_INTERVAL_MS, remainingMs);
				if (tickMs <= 0) break;

				this._deps.emit({
					type: "credential_wait_tick",
					provider: waitProvider,
					remainingMs,
					credentialSummary: this._buildRecoverySummary(providers),
				});

				try {
					await this._sleep(tickMs, signal);
				} catch {
					break;
				}
			}

			if (!signal.aborted) {
				await this._refreshRecoveryCandidates(providers);
			}
		}
	}
}

/** Format a timestamp as an absolute time string (e.g. "15:42:30") */
function _formatAbsoluteTime(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
