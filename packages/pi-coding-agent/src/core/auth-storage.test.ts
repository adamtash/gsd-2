import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthStorage } from "./auth-storage.js";
import { registerOAuthProvider, resetOAuthProviders } from "@gsd/pi-ai/oauth";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeKey(key: string) {
	return { type: "api_key" as const, key };
}

function makeOAuth(access: string, refresh = `refresh-${access}`) {
	return {
		type: "oauth" as const,
		access,
		refresh,
		expires: Date.now() + 60_000,
	};
}

function makeOAuthAccount(access: string, options: { refresh?: string; accountId?: string; email?: string; expires?: number } = {}) {
	return {
		...makeOAuth(access, options.refresh ?? `refresh-${access}`),
		accountId: options.accountId,
		email: options.email,
		expires: options.expires ?? Date.now() + 60_000,
	};
}

function makeJwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

function inMemory(data: Record<string, unknown> = {}) {
	return AuthStorage.inMemory(data as any);
}

// ─── single credential (backward compat) ─────────────────────────────────────

describe("AuthStorage — single credential (backward compat)", () => {
	it("returns the api key for a provider with one key", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-abc") });
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-abc");
	});

	it("returns undefined for unknown provider", async () => {
		const storage = inMemory({});
		const key = await storage.getApiKey("unknown");
		assert.equal(key, undefined);
	});

	it("runtime override takes precedence over stored key", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-stored") });
		storage.setRuntimeApiKey("anthropic", "sk-runtime");
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-runtime");
	});
});

// ─── multiple credentials ─────────────────────────────────────────────────────

describe("AuthStorage — multiple credentials", () => {
	it("round-robins across multiple api keys without sessionId", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});

		const keys = new Set<string>();
		for (let i = 0; i < 6; i++) {
			const k = await storage.getApiKey("anthropic");
			assert.ok(k, `call ${i} should return a key`);
			keys.add(k);
		}
		// All three keys should have been selected across 6 calls
		assert.deepEqual(keys, new Set(["sk-1", "sk-2", "sk-3"]));
	});

	it("session-sticky: same sessionId always picks the same key", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});

		const sessionId = "sess-abc";
		const first = await storage.getApiKey("anthropic", sessionId);
		for (let i = 0; i < 5; i++) {
			const k = await storage.getApiKey("anthropic", sessionId);
			assert.equal(k, first, `call ${i} should be sticky to first selection`);
		}
	});

	it("different sessionIds may select different keys", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});

		const results = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const k = await storage.getApiKey("anthropic", `sess-${i}`);
			if (k) results.add(k);
		}
		// With 20 different sessions and 3 keys, we should see more than one key
		assert.ok(results.size > 1, "multiple sessions should hash to different keys");
	});

	it("uses the preferred credential as the default selection across sessions", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")],
		});
		const credentials = storage.getCredentialsForProvider("anthropic");
		const preferred = credentials[2];
		assert.ok(preferred?.id);

		storage.setPreferredCredential("anthropic", preferred.id!);

		const keyWithoutSession = await storage.getApiKey("anthropic");
		const keyWithSession = await storage.getApiKey("anthropic", "sess-pref");
		assert.equal(keyWithoutSession, "sk-3");
		assert.equal(keyWithSession, "sk-3");
	});

	it("prefers the credential whose available quota resets sooner", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});
		const credentials = storage.getCredentialsForProvider("anthropic");
		(storage as any).providerRoundRobinIndex.set("anthropic", 1);
		(storage as any).credentialRateLimitInfo.set(
			"anthropic",
			new Map([
				[
					credentials[0].id,
					{
						credentialId: credentials[0].id,
						provider: "anthropic",
						label: credentials[0].label,
						fetchedAt: Date.now(),
						fiveHour: { utilization: 25, resetsAt: Date.now() + 30 * 60_000 },
						weekly: null,
						isRateLimited: false,
						availableAt: null,
					},
				],
				[
					credentials[1].id,
					{
						credentialId: credentials[1].id,
						provider: "anthropic",
						label: credentials[1].label,
						fetchedAt: Date.now(),
						fiveHour: { utilization: 25, resetsAt: Date.now() + 2 * 60 * 60_000 },
						weekly: null,
						isRateLimited: false,
						availableAt: null,
					},
				],
			]),
		);

		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-1");
	});

	it("prefers more remaining capacity when reset times are tied", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});
		const credentials = storage.getCredentialsForProvider("anthropic");
		(storage as any).providerRoundRobinIndex.set("anthropic", 1);
		const sharedResetAt = Date.now() + 45 * 60_000;
		(storage as any).credentialRateLimitInfo.set(
			"anthropic",
			new Map([
				[
					credentials[0].id,
					{
						credentialId: credentials[0].id,
						provider: "anthropic",
						label: credentials[0].label,
						fetchedAt: Date.now(),
						fiveHour: { utilization: 80, resetsAt: sharedResetAt },
						weekly: null,
						isRateLimited: false,
						availableAt: null,
					},
				],
				[
					credentials[1].id,
					{
						credentialId: credentials[1].id,
						provider: "anthropic",
						label: credentials[1].label,
						fetchedAt: Date.now(),
						fiveHour: { utilization: 20, resetsAt: sharedResetAt },
						weekly: null,
						isRateLimited: false,
						availableAt: null,
					},
				],
			]),
		);

		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-2");
	});
});

// ─── login accumulation ───────────────────────────────────────────────────────

describe("AuthStorage — login accumulation", () => {
	it("accumulates api keys on repeated set()", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeKey("sk-1"));
		storage.set("anthropic", makeKey("sk-2"));
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 2);
		assert.deepEqual(
			creds.map((c) => (c.type === "api_key" ? c.key : null)),
			["sk-1", "sk-2"],
		);
	});

	it("deduplicates identical api keys", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeKey("sk-1"));
		storage.set("anthropic", makeKey("sk-1"));
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 1);
	});

	it("accumulates oauth credentials on repeated login", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeOAuth("oauth-1"));
		storage.set("anthropic", makeOAuth("oauth-2"));
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 2);
		assert.deepEqual(
			creds.map((c) => (c.type === "oauth" ? c.access : null)),
			["oauth-1", "oauth-2"],
		);
	});

	it("relogin for the same oauth account overrides instead of appending", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeOAuthAccount("oauth-1", {
			accountId: "acct-123",
			email: "user@example.com",
		}));
		storage.set("anthropic", makeOAuthAccount("oauth-2", {
			accountId: "acct-123",
			email: "user@example.com",
			refresh: "refresh-oauth-2",
		}));

		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 1);
		assert.equal(creds[0].label, "user@example.com");
		assert.equal(creds[0].type === "oauth" ? creds[0].access : null, "oauth-2");
	});

	it("relogin with a different email appends instead of overriding even if account ids match", () => {
		const storage = inMemory({});
		storage.set("openai-codex", makeOAuthAccount("oauth-1", {
			accountId: "acct-shared",
			email: "first@example.com",
		}));
		storage.set("openai-codex", makeOAuthAccount("oauth-2", {
			accountId: "acct-shared",
			email: "second@example.com",
			refresh: "refresh-oauth-2",
		}));

		const creds = storage.getCredentialsForProvider("openai-codex");
		assert.equal(creds.length, 2);
		assert.deepEqual(
			creds.map((credential) => credential.label),
			["first@example.com", "second@example.com"],
		);
	});

	it("relogin with the same email but a different account id appends as a separate account", () => {
		const storage = inMemory({});
		storage.set("openai-codex", makeOAuthAccount("oauth-1", {
			accountId: "acct-team-1",
			email: "work1@example.com",
		}));
		storage.set("openai-codex", makeOAuthAccount("oauth-2", {
			accountId: "acct-team-2",
			email: "work1@example.com",
			refresh: "refresh-oauth-2",
		}));

		const creds = storage.getCredentialsForProvider("openai-codex");
		assert.equal(creds.length, 2);
		assert.deepEqual(
			creds.map((credential) => credential.type === "oauth" ? credential.accountId : undefined),
			["acct-team-1", "acct-team-2"],
		);
	});

	it("oauth credentials without email append as separate accounts", () => {
		const storage = inMemory({});
		storage.set("openai-codex", makeOAuthAccount("oauth-1", {
			accountId: "acct-123",
		}));
		storage.set("openai-codex", makeOAuthAccount("oauth-2", {
			accountId: "acct-123",
			refresh: "refresh-oauth-2",
		}));

		const creds = storage.getCredentialsForProvider("openai-codex");
		assert.equal(creds.length, 2);
	});

	it("normalizes generic oauth labels to email when identity metadata exists", () => {
		const storage = inMemory({
			anthropic: {
				...makeOAuthAccount("oauth-1", { accountId: "acct-1", email: "person@example.com" }),
				label: "Subscription 1",
			},
		});

		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds[0].label, "person@example.com");
	});

	it("upgrades generated account-id oauth labels to email when identity metadata exists", () => {
		const storage = inMemory({
			"openai-codex": {
				...makeOAuthAccount("oauth-1", { accountId: "acct_1234567890", email: "codex@example.com" }),
				label: "Account acct_123",
			},
		});

		const creds = storage.getCredentialsForProvider("openai-codex");
		assert.equal(creds[0].label, "codex@example.com");
	});

	it("extracts oauth identity metadata from jwt tokens for labels and override matching", () => {
		const firstToken = makeJwt({ sub: "acct-jwt-1", email: "jwt@example.com", name: "JWT User" });
		const secondToken = makeJwt({ sub: "acct-jwt-1", email: "jwt@example.com", name: "JWT User" });
		const storage = inMemory({});
		storage.set("openai-codex", { ...makeOAuth(firstToken, "refresh-jwt-1"), label: "Subscription 1" });
		storage.set("openai-codex", { ...makeOAuth(secondToken, "refresh-jwt-2"), label: "Subscription 2" });

		const creds = storage.getCredentialsForProvider("openai-codex");
		assert.equal(creds.length, 1);
		assert.equal(creds[0].label, "jwt@example.com");
		assert.equal(creds[0].type === "oauth" ? creds[0].refresh : null, "refresh-jwt-2");
	});

	it("refreshes only the targeted oauth credential without duplicating another account", async () => {
		registerOAuthProvider({
			id: "test-oauth-refresh",
			name: "Test OAuth Refresh",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: `${String(credentials.access)}-refreshed`,
					expires: Date.now() + 60_000,
				};
			},
			getApiKey(credentials) {
				return String(credentials.access);
			},
		});

		try {
			const storage = inMemory({
				"test-oauth-refresh": [
					{ ...makeOAuth("oauth-1"), expires: Date.now() + 60_000, label: "Account 1", id: "cred_one" },
					{ ...makeOAuth("oauth-2"), expires: Date.now() - 1_000, label: "Account 2", id: "cred_two" },
				],
			});

			storage.setPreferredCredential("test-oauth-refresh", "cred_two");
			const apiKey = await storage.getApiKey("test-oauth-refresh");
			assert.equal(apiKey, "oauth-2-refreshed");

			const creds = storage.getCredentialsForProvider("test-oauth-refresh");
			assert.equal(creds.length, 2);
			assert.equal(creds[0].id, "cred_one");
			assert.equal(creds[1].id, "cred_two");
			assert.equal(creds[0].type === "oauth" ? creds[0].access : null, "oauth-1");
			assert.equal(creds[1].type === "oauth" ? creds[1].access : null, "oauth-2-refreshed");
		} finally {
			resetOAuthProviders();
		}
	});

	it("refreshes oauth credentials shortly before expiration", async () => {
		registerOAuthProvider({
			id: "test-oauth-early-refresh",
			name: "Test OAuth Early Refresh",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: `${String(credentials.access)}-fresh`,
					expires: Date.now() + 120_000,
				};
			},
			getApiKey(credentials) {
				return String(credentials.access);
			},
		});

		try {
			const storage = inMemory({
				"test-oauth-early-refresh": {
					...makeOAuthAccount("oauth-1", {
						accountId: "acct-pre-refresh",
						email: "early@example.com",
						expires: Date.now() + 30_000,
					}),
					id: "cred_pre_refresh",
				},
			});

			const apiKey = await storage.getApiKey("test-oauth-early-refresh");
			assert.equal(apiKey, "oauth-1-fresh");
			const creds = storage.getCredentialsForProvider("test-oauth-early-refresh");
			assert.equal(creds[0].type === "oauth" ? creds[0].access : null, "oauth-1-fresh");
		} finally {
			resetOAuthProviders();
		}
	});
});

// ─── backoff / markUsageLimitReached ─────────────────────────────────────────

describe("AuthStorage — rate-limit backoff", () => {
	it("returns true when a backed-off credential has an alternate", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// Use sk-1 via round-robin (first call, index 0)
		await storage.getApiKey("anthropic");

		// Mark it as rate-limited; sk-2 should still be available
		const hasAlternate = storage.markUsageLimitReached("anthropic");
		assert.equal(hasAlternate, true);
	});

	it("returns false when all credentials are backed off", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// Back off both keys
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		await storage.getApiKey("anthropic"); // uses index 1
		const hasAlternate = storage.markUsageLimitReached("anthropic"); // backs off index 1
		assert.equal(hasAlternate, false);
	});

	it("backed-off credential is skipped; next available key is returned", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		// First call → sk-1 (round-robin index 0)
		const first = await storage.getApiKey("anthropic");
		assert.equal(first, "sk-1");

		// Back off sk-1
		storage.markUsageLimitReached("anthropic");

		// Next call should skip backed-off sk-1 and return sk-2
		const second = await storage.getApiKey("anthropic");
		assert.equal(second, "sk-2");
	});

	it("single credential: markUsageLimitReached returns false", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");
		const hasAlternate = storage.markUsageLimitReached("anthropic");
		assert.equal(hasAlternate, false);
	});

	it("single credential: unknown error type skips backoff entirely", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");

		// Mark with unknown error type (transport failure)
		const hasAlternate = storage.markUsageLimitReached("anthropic", undefined, {
			errorType: "unknown",
		});
		assert.equal(hasAlternate, false);

		// Key should still be available — backoff was not applied
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-only");
	});

	it("multiple credentials: unknown error type still backs off the used credential", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});
		await storage.getApiKey("anthropic"); // uses sk-1

		// Mark with unknown error type — should still back off when alternates exist
		const hasAlternate = storage.markUsageLimitReached("anthropic", undefined, {
			errorType: "unknown",
		});
		assert.equal(hasAlternate, true);

		// Next call should return sk-2
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, "sk-2");
	});

	it("single credential: rate_limit error type still backs off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");

		// rate_limit should still back off even single credentials
		const hasAlternate = storage.markUsageLimitReached("anthropic", undefined, {
			errorType: "rate_limit",
		});
		assert.equal(hasAlternate, false);

		// Key should be backed off
		const key = await storage.getApiKey("anthropic");
		assert.equal(key, undefined);
	});

	it("session-sticky: marks the correct credential as backed off", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		const sessionId = "sess-xyz";
		const chosen = await storage.getApiKey("anthropic", sessionId);
		assert.ok(chosen);

		// Back off the chosen credential for this session
		const hasAlternate = storage.markUsageLimitReached("anthropic", sessionId);
		assert.equal(hasAlternate, true);

		// Next call with same session should return the other key
		const next = await storage.getApiKey("anthropic", sessionId);
		assert.ok(next);
		assert.notEqual(next, chosen);
	});

	it("returns detailed rotation info for used and next credentials", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		await storage.getApiKey("anthropic", "sess-rotate");
		const rotation = storage.markUsageLimitReachedWithFallback("anthropic", "sess-rotate", {
			errorType: "rate_limit",
		});

		assert.equal(rotation.hasAlternate, true);
		assert.ok(rotation.usedCredential);
		assert.ok(rotation.nextCredential);
		assert.notEqual(rotation.usedCredential?.id, rotation.nextCredential?.id);
	});

	it("quota exhaustion skips other credentials on the same underlying oauth account", async () => {
		registerOAuthProvider({
			id: "test-oauth-group",
			name: "Test OAuth Group",
			login: async () => {
				throw new Error("not implemented");
			},
			refreshToken: async () => {
				throw new Error("not implemented");
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		try {
			const storage = inMemory({
				"test-oauth-group": [
					makeOAuthAccount("oauth-a1", { accountId: "acct-team-a", email: "work1@example.com", expires: Date.now() + 120_000 }),
					makeOAuthAccount("oauth-a2", { accountId: "acct-team-a", email: "work2@example.com", expires: Date.now() + 120_000 }),
					makeOAuthAccount("oauth-b1", { accountId: "acct-team-b", email: "work3@example.com", expires: Date.now() + 120_000 }),
				],
			});

			const first = await storage.getApiKey("test-oauth-group");
			assert.equal(first, "oauth-a1");

			const rotation = storage.markUsageLimitReachedWithFallback("test-oauth-group", undefined, {
				errorType: "quota_exhausted",
			});

			assert.equal(rotation.hasAlternate, true);
			assert.equal(rotation.usedCredential?.type, "oauth");
			assert.equal(rotation.nextCredential?.type, "oauth");
			assert.equal(rotation.usedCredential?.type === "oauth" ? rotation.usedCredential.accountId : undefined, "acct-team-a");
			assert.equal(rotation.nextCredential?.type === "oauth" ? rotation.nextCredential.accountId : undefined, "acct-team-b");

			const next = await storage.getApiKey("test-oauth-group");
			assert.equal(next, "oauth-b1");
		} finally {
			resetOAuthProviders();
		}
	});
});

// ─── pool inspection / targeted removal ─────────────────────────────────────

describe("AuthStorage — credential pools", () => {
	it("reports active and backed-off credentials in the pool", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});

		await storage.getApiKey("anthropic", "sess-pool");
		let pool = storage.getCredentialPool("anthropic", "sess-pool");
		assert.equal(pool.length, 2);
		assert.equal(pool.filter((credential) => credential.isActive).length, 1);

		storage.markUsageLimitReachedWithFallback("anthropic", "sess-pool", { errorType: "rate_limit" });
		pool = storage.getCredentialPool("anthropic", "sess-pool");
		assert.equal(pool.filter((credential) => credential.isBackedOff).length, 1);
		assert.equal(pool.filter((credential) => credential.isActive).length, 1);
	});

	it("removeCredential removes only the selected oauth account", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeOAuth("oauth-1"));
		storage.set("anthropic", makeOAuth("oauth-2"));

		const initial = storage.getCredentialsForProvider("anthropic");
		assert.equal(initial.length, 2);
		const removed = storage.removeCredential("anthropic", initial[0].id!);

		assert.ok(removed);
		const remaining = storage.getCredentialsForProvider("anthropic");
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].id, initial[1].id);
	});

	it("detects oauth presence even when the selected credential is not yet resolved", () => {
		const storage = inMemory({ anthropic: [makeOAuth("oauth-1"), makeOAuth("oauth-2")] });
		assert.equal(storage.hasOAuth("anthropic"), true);
		const selected = storage.getSelectedCredential("anthropic", "sess-oauth");
		assert.equal(selected?.type, "oauth");
	});

	it("marks a preferred credential in the pool and clears prior session selection", async () => {
		const storage = inMemory({ anthropic: [makeOAuth("oauth-1"), makeOAuth("oauth-2")] });
		await storage.getApiKey("anthropic", "sess-preferred-pool");
		const credentials = storage.getCredentialsForProvider("anthropic");
		storage.setPreferredCredential("anthropic", credentials[1].id!);

		const pool = storage.getCredentialPool("anthropic", "sess-preferred-pool");
		assert.equal(pool.filter((credential) => credential.isPreferred).length, 1);
		assert.equal(pool[1].isPreferred, true);
		assert.equal(pool[1].isActive, true);
	});
});

// ─── areAllCredentialsBackedOff ───────────────────────────────────────────────

describe("AuthStorage — areAllCredentialsBackedOff", () => {
	it("returns false when no credentials are configured", () => {
		const storage = inMemory({});
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
	});

	it("returns false when credentials exist and none are backed off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-abc") });
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
	});

	it("returns true when the single credential is backed off", async () => {
		const storage = inMemory({ anthropic: makeKey("sk-only") });
		await storage.getApiKey("anthropic");
		storage.markUsageLimitReached("anthropic");
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), true);
	});

	it("returns false when at least one credential is still available", async () => {
		const storage = inMemory({ anthropic: [makeKey("sk-1"), makeKey("sk-2")] });
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		// index 1 is still available
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
	});

	it("returns true when all credentials are backed off", async () => {
		const storage = inMemory({ anthropic: [makeKey("sk-1"), makeKey("sk-2")] });
		await storage.getApiKey("anthropic"); // uses index 0
		storage.markUsageLimitReached("anthropic"); // backs off index 0
		await storage.getApiKey("anthropic"); // uses index 1
		storage.markUsageLimitReached("anthropic"); // backs off index 1
		assert.equal(storage.areAllCredentialsBackedOff("anthropic"), true);
	});
});

// ─── mismatched oauth credential for non-OAuth provider (#2083) ───────────────

describe("AuthStorage — oauth credential for non-OAuth provider (#2083)", () => {
	it("returns undefined when openrouter has type:oauth (no registered OAuth provider)", async (t) => {
		// Simulates the bug: OpenRouter credential stored as type:"oauth"
		// but OpenRouter is not a registered OAuth provider.
		const storage = inMemory({
			openrouter: {
				type: "oauth",
				access_token: "sk-or-v1-fake",
				refresh_token: "rt-fake",
				expires: Date.now() + 3_600_000,
			},
		});

		// Isolate from any real OPENROUTER_API_KEY in the environment so the
		// fall-through to env / fallback finds nothing and returns undefined.
		const origEnv = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		t.after(() => {
			if (origEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = origEnv;
			}
		});

		// Before the fix, getApiKey returns undefined because
		// resolveCredentialApiKey calls getOAuthProvider("openrouter") → null → undefined.
		// The key in the oauth credential is never extracted.
		const key = await storage.getApiKey("openrouter");
		// After the fix, the oauth credential with an unrecognised provider
		// should be skipped, and getApiKey should fall through to env / fallback.
		// With no env var and no fallback resolver configured, the result is undefined.
		assert.equal(key, undefined);
	});

	it("falls through to env var when openrouter has type:oauth credential", async (t) => {
		const storage = inMemory({
			openrouter: {
				type: "oauth",
				access_token: "sk-or-v1-fake",
				refresh_token: "rt-fake",
				expires: Date.now() + 3_600_000,
			},
		});

		// Simulate OPENROUTER_API_KEY being set via env
		const origEnv = process.env.OPENROUTER_API_KEY;
		t.after(() => {
			if (origEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = origEnv;
			}
		});

		process.env.OPENROUTER_API_KEY = "sk-or-v1-env-key";
		const key = await storage.getApiKey("openrouter");
		assert.equal(key, "sk-or-v1-env-key");
	});

	it("falls through to fallback resolver when openrouter has type:oauth credential", async (t) => {
		const storage = inMemory({
			openrouter: {
				type: "oauth",
				access_token: "sk-or-v1-fake",
				refresh_token: "rt-fake",
				expires: Date.now() + 3_600_000,
			},
		});

		// Isolate from any real OPENROUTER_API_KEY so env fallback is skipped
		// and the fallback resolver is reached.
		const origEnv = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		t.after(() => {
			if (origEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = origEnv;
			}
		});

		storage.setFallbackResolver((provider) =>
			provider === "openrouter" ? "sk-or-v1-fallback" : undefined,
		);

		const key = await storage.getApiKey("openrouter");
		assert.equal(key, "sk-or-v1-fallback");
	});
});

// ─── getAll truncation ────────────────────────────────────────────────────────

describe("AuthStorage — getAll()", () => {
	it("returns first credential only for providers with multiple keys", () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
			openai: makeKey("sk-openai"),
		});
		const all = storage.getAll();
		assert.ok(all["anthropic"]?.type === "api_key");
		assert.equal((all["anthropic"] as any).key, "sk-1");
		assert.equal((all["openai"] as any).key, "sk-openai");
	});
});

// ─── removeCredential edge cases ─────────────────────────────────────────────

describe("AuthStorage — removeCredential edge cases", () => {
	it("returns undefined when credential id does not exist", () => {
		const storage = inMemory({ anthropic: makeKey("sk-1") });
		const result = storage.removeCredential("anthropic", "nonexistent-id");
		assert.equal(result, undefined);
		assert.equal(storage.getCredentialsForProvider("anthropic").length, 1);
	});

	it("returns undefined when provider does not exist", () => {
		const storage = inMemory({});
		const result = storage.removeCredential("unknown", "some-id");
		assert.equal(result, undefined);
	});

	it("removes the provider entirely when the last credential is removed", () => {
		const storage = inMemory({});
		storage.set("anthropic", makeOAuth("oauth-1"));
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds.length, 1);
		storage.removeCredential("anthropic", creds[0].id!);
		assert.equal(storage.getCredentialsForProvider("anthropic").length, 0);
		assert.equal(storage.hasAuth("anthropic"), false);
	});
});

// ─── getEarliestCredentialRecovery ────────────────────────────────────────────

describe("AuthStorage — getEarliestCredentialRecovery", () => {
	it("returns undefined when no rate limit info is cached", async () => {
		const storage = inMemory({
			anthropic: [makeKey("sk-1"), makeKey("sk-2")],
		});
		const recovery = storage.getEarliestCredentialRecovery("anthropic");
		assert.equal(recovery, undefined);
	});

	it("returns undefined for unknown providers", () => {
		const storage = inMemory({});
		const recovery = storage.getEarliestCredentialRecovery("unknown");
		assert.equal(recovery, undefined);
	});
});

// ─── enrichOAuthCredentialFromToken (JWT identity extraction) ─────────────────

describe("AuthStorage — JWT identity extraction", () => {
	it("extracts standard claims from access token JWT", () => {
		const jwt = makeJwt({ sub: "user-123", email: "jwt@test.com", name: "Test User" });
		const storage = inMemory({});
		storage.set("anthropic", { ...makeOAuth(jwt), label: "Subscription 1" });
		const creds = storage.getCredentialsForProvider("anthropic");
		assert.equal(creds[0].label, "jwt@test.com");
	});

	it("preserves existing identity metadata over JWT claims", () => {
		const jwt = makeJwt({ sub: "user-456", email: "jwt@other.com" });
		const storage = inMemory({});
		storage.set("anthropic", makeOAuthAccount(jwt, {
			accountId: "existing-id",
			email: "existing@email.com",
		}));
		const creds = storage.getCredentialsForProvider("anthropic");
		// Existing metadata takes precedence
		assert.equal(creds[0].label, "existing@email.com");
	});

	it("handles non-JWT access tokens gracefully", () => {
		const storage = inMemory({});
		storage.set("anthropic", { ...makeOAuth("not-a-jwt-token"), label: "Subscription 1" });
		const creds = storage.getCredentialsForProvider("anthropic");
		// Should still work, just without identity extraction
		assert.equal(creds.length, 1);
		assert.equal(creds[0].label, "Subscription 1");
	});
});
