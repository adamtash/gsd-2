import { describe, it, mock, type Mock } from "node:test";
import assert from "node:assert/strict";

import type { Api, AssistantMessage, Model } from "@gsd/pi-ai";

import { RetryHandler, type RetryHandlerDeps } from "./retry-handler.js";
import type { FallbackResolver } from "./fallback-resolver.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SettingsManager } from "./settings-manager.js";

function createMockModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic" as Api,
		provider,
		baseUrl: `https://api.${provider}.com`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 16384,
	} as Model<Api>;
}

function errorMessage(msg: string, modelId = "claude-opus-4-6"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: msg,
		timestamp: Date.now(),
	} as AssistantMessage;
}

type AuthState = {
	markUsageLimitReachedResult?: boolean;
	providerAvailable?: Record<string, boolean>;
	allBackedOff?: Record<string, boolean>;
	pool?: Record<string, Array<{ id: string; label: string; isBackedOff: boolean }>>;
	providerBackoffMs?: Record<string, number>;
	earliestRecoveryMs?: Record<string, number>;
};

function createMockDeps(overrides?: {
	model?: Model<Api>;
	fallbackResult?: { model: Model<Api>; chainName: string; reason: string } | null;
	recoveryCandidates?: string[];
	resolveRecoveryModel?: (currentModel: Model<Api>, provider: string) => Model<Api> | undefined;
	findModelResult?: (provider: string, modelId: string) => Model<Api> | undefined;
	isProviderRequestReady?: (provider: string) => boolean;
	authState?: AuthState;
	onSleep?: () => void;
	retryEnabled?: boolean;
	markUsageLimitReachedResult?: boolean;
	retrySettings?: {
		maxRetries?: number;
		baseDelayMs?: number;
		maxDelayMs?: number;
	};
}): {
	deps: RetryHandlerDeps;
	emittedEvents: Array<Record<string, any>>;
	continueFn: Mock<() => Promise<void>>;
	setModelFn: Mock<(model: Model<Api>) => void>;
	findFallback: Mock<(...args: any[]) => Promise<any>>;
	markUsageLimitReached: Mock<(...args: any[]) => boolean>;
	onModelChangeFn: Mock<(model: Model<any>) => void>;
} {
	const currentModel = overrides?.model ?? createMockModel("anthropic", "claude-opus-4-6");
	const messages: Array<{ role: string } & Record<string, any>> = [];
	const emittedEvents: Array<Record<string, any>> = [];

	const setModelFn = mock.fn((model: Model<Api>) => {
		current.value = model;
	});
	const continueFn = mock.fn(async () => {});
	const current = { value: currentModel };
	let now = Date.now();

	const authState: Required<AuthState> = {
		markUsageLimitReachedResult: overrides?.authState?.markUsageLimitReachedResult ?? false,
		providerAvailable: overrides?.authState?.providerAvailable ?? { [currentModel.provider]: true },
		allBackedOff: overrides?.authState?.allBackedOff ?? { [currentModel.provider]: false },
		pool: overrides?.authState?.pool ?? {
			[currentModel.provider]: [
				{ id: `${currentModel.provider}-1`, label: `${currentModel.provider} credential`, isBackedOff: false },
			],
		},
		providerBackoffMs: overrides?.authState?.providerBackoffMs ?? {},
		earliestRecoveryMs: overrides?.authState?.earliestRecoveryMs ?? {},
	};

	const markUsageLimitReached = mock.fn(() =>
		overrides?.markUsageLimitReachedResult ?? authState.markUsageLimitReachedResult,
	);
	const findFallback = mock.fn(async () => overrides?.fallbackResult ?? null);
	const onModelChangeFn = mock.fn((_model: Model<any>) => {});

	const deps: RetryHandlerDeps = {
		agent: {
			continue: continueFn,
			state: { messages, model: current.value },
			setModel: setModelFn,
			replaceMessages: mock.fn((next: any[]) => {
				messages.length = 0;
				messages.push(...next);
			}),
		} as any,
		settingsManager: {
			getRetryEnabled: () => true,
			getRetrySettings: () => ({
				enabled: overrides?.retryEnabled ?? true,
				maxRetries: overrides?.retrySettings?.maxRetries ?? 5,
				baseDelayMs: overrides?.retrySettings?.baseDelayMs ?? 1000,
				maxDelayMs: overrides?.retrySettings?.maxDelayMs ?? 30000,
			}),
		} as unknown as SettingsManager,
		modelRegistry: {
			authStorage: {
				markUsageLimitReached,
				areAllCredentialsBackedOff: (provider: string) => authState.allBackedOff[provider] ?? false,
				isProviderAvailable: (provider: string) => authState.providerAvailable[provider] ?? true,
				hasAuth: (provider: string) => provider in authState.pool,
				getCredentialPool: (provider: string) =>
					(authState.pool[provider] ?? []).map((credential, index) => ({
						...credential,
						type: "oauth" as const,
						isActive: index === 0,
						isPreferred: index === 0,
						backoffRemainingMs: credential.isBackedOff ? (authState.providerBackoffMs[provider] ?? 1000) : 0,
					})),
				getProviderRateLimitInfo: () => [],
				getProviderBackoffRemaining: (provider: string) => authState.providerBackoffMs[provider] ?? 0,
				getEarliestCredentialRecovery: (provider: string) => {
					const waitMs = authState.earliestRecoveryMs[provider];
					return waitMs
						? {
							credentialId: `${provider}-1`,
							label: `${provider} credential`,
							waitMs,
							availableAt: Date.now() + waitMs,
						}
						: undefined;
				},
				refreshProviderRateLimitInfo: async () => [],
			},
			find: mock.fn(
				overrides?.findModelResult ?? ((_provider: string, _modelId: string) => undefined),
			),
			getPreferredModelForProvider: (provider: string) => {
				if (provider === current.value.provider) return current.value;
				return createMockModel(provider, provider === "openai" ? "gpt-4.1" : "model");
			},
			isProviderRequestReady: overrides?.isProviderRequestReady ?? (() => true),
		} as unknown as ModelRegistry,
		fallbackResolver: {
			findFallback,
			getRecoveryCandidateProviders: () => overrides?.recoveryCandidates ?? [current.value.provider],
			resolveRecoveryModel:
				overrides?.resolveRecoveryModel ??
				((currentModelArg: Model<Api>, provider: string) =>
					provider === currentModelArg.provider ? currentModelArg : createMockModel(provider, "gpt-4.1")),
		} as unknown as FallbackResolver,
		getModel: () => current.value,
		getSessionId: () => "test-session",
		emit: (event: any) => emittedEvents.push(event),
		onModelChange: onModelChangeFn,
		sleepFn: async (ms: number) => {
			now += ms;
			overrides?.onSleep?.();
		},
		now: () => now,
	};

	return { deps, emittedEvents, continueFn, setModelFn, findFallback, markUsageLimitReached, onModelChangeFn };
}

describe("RetryHandler", () => {
	it("falls back to another provider when a single-credential provider is rate limited", async () => {
		const fallbackModel = createMockModel("openai", "gpt-4.1");
		const { deps, emittedEvents, continueFn, setModelFn, findFallback, markUsageLimitReached } = createMockDeps({
			fallbackResult: {
				model: fallbackModel,
				chainName: "coding",
				reason: "falling back to openai/gpt-4.1",
			},
			authState: {
				// Credential is NOT yet backed off locally — this is a fresh 429 from the API.
				// markUsageLimitReached should be called once to record the backoff,
				// then return false (no alternate available for single-credential provider).
				markUsageLimitReachedResult: false,
				allBackedOff: { anthropic: false },
				pool: {
					anthropic: [{ id: "anthropic-1", label: "anthropic primary", isBackedOff: false }],
					openai: [{ id: "openai-1", label: "openai backup", isBackedOff: false }],
				},
			},
		});

		const handler = new RetryHandler(deps);
		const retried = await handler.handleRetryableError(errorMessage("429 Too Many Requests"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(retried, true);
		assert.equal(markUsageLimitReached.mock.calls.length, 1);
		assert.equal(findFallback.mock.calls.length, 1);
		assert.equal(setModelFn.mock.calls.length, 1);
		assert.equal(setModelFn.mock.calls[0].arguments[0].provider, "openai");
		assert.equal(continueFn.mock.calls.length, 1);

		const switchEvent = emittedEvents.find((event) => event.type === "fallback_provider_switch");
		assert.ok(switchEvent);
		assert.equal(switchEvent?.to, "openai/gpt-4.1");
	});

	it("skips markUsageLimitReached when all credentials are already locally backed off", async () => {
		// Simulates the case where sdk.ts threw a local error before making any API call
		// (all credentials were already in backoff). markUsageLimitReached must NOT be
		// called because it would escalate the backoff on credentials that weren't used.
		const fallbackModel = createMockModel("openai", "gpt-4.1");
		const { deps, continueFn, setModelFn, findFallback, markUsageLimitReached } = createMockDeps({
			fallbackResult: {
				model: fallbackModel,
				chainName: "coding",
				reason: "falling back to openai/gpt-4.1",
			},
			authState: {
				markUsageLimitReachedResult: false,
				allBackedOff: { anthropic: true }, // all already backed off locally
				pool: {
					anthropic: [{ id: "anthropic-1", label: "anthropic primary", isBackedOff: true }],
					openai: [{ id: "openai-1", label: "openai backup", isBackedOff: false }],
				},
			},
		});

		const handler = new RetryHandler(deps);
		const retried = await handler.handleRetryableError(
			errorMessage('All credentials for "anthropic" are temporarily backed off due to rate limiting.'),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(retried, true);
		// markUsageLimitReached must NOT be called — no API call was made
		assert.equal(markUsageLimitReached.mock.calls.length, 0);
		assert.equal(findFallback.mock.calls.length, 1);
		assert.equal(setModelFn.mock.calls[0].arguments[0].provider, "openai");
		assert.equal(continueFn.mock.calls.length, 1);
	});

	it("waits for the first recovered provider across the recovery pool and resumes there", async () => {
		const currentModel = createMockModel("anthropic", "claude-opus-4-6");
		const openaiModel = createMockModel("openai", "gpt-4.1");
		const providerAvailable = { anthropic: false, openai: false };
		const allBackedOff = { anthropic: true, openai: true };
		const providerBackoffMs = { anthropic: 60_000, openai: 1_000 };
		const earliestRecoveryMs = { anthropic: 60_000, openai: 1_000 };

		const { deps, emittedEvents, continueFn, setModelFn } = createMockDeps({
			model: currentModel,
			fallbackResult: null,
			recoveryCandidates: ["anthropic", "openai"],
			resolveRecoveryModel: (model, provider) => (provider === "anthropic" ? model : openaiModel),
			authState: {
				markUsageLimitReachedResult: false,
				providerAvailable,
				allBackedOff,
				providerBackoffMs,
				earliestRecoveryMs,
				pool: {
					anthropic: [{ id: "anthropic-1", label: "anthropic primary", isBackedOff: true }],
					openai: [{ id: "openai-1", label: "openai backup", isBackedOff: true }],
				},
			},
			onSleep: () => {
				providerAvailable.openai = true;
				allBackedOff.openai = false;
				providerBackoffMs.openai = 0;
				earliestRecoveryMs.openai = 0;
			},
		});

		const handler = new RetryHandler(deps);
		const retried = await handler.handleRetryableError(errorMessage("429 Too Many Requests"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(retried, true);
		assert.equal(setModelFn.mock.calls.length, 1);
		assert.equal(setModelFn.mock.calls[0].arguments[0].provider, "openai");
		assert.equal(continueFn.mock.calls.length, 1);

		const waitStart = emittedEvents.find((event) => event.type === "credential_wait_start");
		assert.ok(waitStart);
		assert.equal(waitStart?.provider, "openai");

		const waitEnd = emittedEvents.find((event) => event.type === "credential_wait_end");
		assert.ok(waitEnd);
		assert.equal(waitEnd?.provider, "openai");

		const switchEvent = emittedEvents.find((event) => event.type === "fallback_provider_switch");
		assert.ok(switchEvent);
		assert.equal(switchEvent?.to, "openai/gpt-4.1");
		assert.match(String(switchEvent?.reason), /provider recovered after wait/);
	});

	it("still downgrades long-context models before entering the wait loop", async () => {
		const baseModel = createMockModel("anthropic", "claude-opus-4-6");
		const { deps, emittedEvents, continueFn, setModelFn } = createMockDeps({
			model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
			fallbackResult: null,
			findModelResult: (provider: string, modelId: string) =>
				provider === "anthropic" && modelId === "claude-opus-4-6" ? baseModel : undefined,
			authState: {
				markUsageLimitReachedResult: false,
				allBackedOff: { anthropic: true },
				pool: {
					anthropic: [{ id: "anthropic-1", label: "anthropic primary", isBackedOff: true }],
				},
			},
		});

		const handler = new RetryHandler(deps);
		const retried = await handler.handleRetryableError(
			errorMessage("Extra usage is required for long context requests.", "claude-opus-4-6[1m]"),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(retried, true);
		assert.equal(setModelFn.mock.calls.length, 1);
		assert.equal(setModelFn.mock.calls[0].arguments[0].id, "claude-opus-4-6");
		assert.equal(continueFn.mock.calls.length, 1);

		const switchEvent = emittedEvents.find((event) => event.type === "fallback_provider_switch");
		assert.ok(switchEvent);
		assert.match(String(switchEvent?.reason), /long context downgrade/);
	});

	describe("retry cancellation", () => {
		it("cancels queued immediate continue callbacks when retry is aborted", async () => {
			const { deps, emittedEvents, continueFn } = createMockDeps({
				markUsageLimitReachedResult: true,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("429 Too Many Requests");

			const result = await handler.handleRetryableError(msg);
			assert.equal(result, true, "retry should be initiated");

			handler.abortRetry();
			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.equal(continueFn.mock.calls.length, 0, "cancelled retry must not continue after explicit abort");
			const endEvents = emittedEvents.filter((e) => e.type === "auto_retry_end");
			assert.equal(endEvents.length, 1, "retry cancellation should emit a single auto_retry_end event");
			assert.equal(endEvents[0]?.finalError, "Retry cancelled");
		});
	});

	describe("isRetryableError", () => {
		it("considers long-context entitlement error as retryable", () => {
			const { deps } = createMockDeps();
			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");
			assert.equal(handler.isRetryableError(msg), true);
		});

		it("does NOT consider credential cooldown error as retryable (#3429)", () => {
			// The credential cooldown message from getApiKey() must not re-enter
			// the retry handler. Re-entry creates cascading empty error entries
			// in the session file that break resume.
			const { deps } = createMockDeps();
			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				'All credentials for "anthropic" are in a cooldown window. ' +
				'Please wait a moment and try again, or switch to a different provider.',
			);
			assert.equal(handler.isRetryableError(msg), false);
		});
	});

	describe("third-party block claude-code fallback (#3772)", () => {
		it("switches to claude-code provider when current provider is anthropic", async () => {
			const ccModel = createMockModel("claude-code", "claude-opus-4-6");
			const { deps, emittedEvents, onModelChangeFn } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				findModelResult: (provider: string, modelId: string) => {
					if (provider === "claude-code" && modelId === "claude-opus-4-6") return ccModel;
					return undefined;
				},
			});
			deps.isClaudeCodeReady = () => true;

			const handler = new RetryHandler(deps);
			const msg = errorMessage("third-party apps cannot draw from extra usage");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "should retry via claude-code fallback");
			const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
			assert.ok(switchEvent, "Expected fallback_provider_switch event");
			assert.ok(switchEvent!.to.startsWith("claude-code/"), "Should switch to claude-code provider");
		});

		it("does NOT switch to claude-code when current provider is not anthropic", async () => {
			const ccModel = createMockModel("claude-code", "gpt-4o");
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("openai", "gpt-4o"),
				findModelResult: (provider: string, modelId: string) => {
					if (provider === "claude-code" && modelId === "gpt-4o") return ccModel;
					return undefined;
				},
			});
			deps.isClaudeCodeReady = () => true;

			const handler = new RetryHandler(deps);
			const msg = errorMessage("third-party apps are not supported for this plan");

			const result = await handler.handleRetryableError(msg);

			// Should NOT have triggered the claude-code fallback
			const switchEvent = emittedEvents.find(
				(e) => e.type === "fallback_provider_switch" && e.to?.startsWith("claude-code/"),
			);
			assert.equal(switchEvent, undefined, "Should NOT switch non-anthropic provider to claude-code");
		});
	});

	describe("quota_exhausted credential backoff (#3430)", () => {
		it("does NOT call markUsageLimitReached for quota_exhausted errors", async () => {
			// "Extra usage is required" is an account-level billing gate.
			// Backing off the credential for 30 minutes blocks all provider
			// requests and has no effect on the billing condition.
			const { deps, markUsageLimitReached } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
				findModelResult: () => undefined,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}',
			);

			await handler.handleRetryableError(msg);

			assert.equal(
				markUsageLimitReached.mock.calls.length,
				0,
				"markUsageLimitReached must NOT be called for quota_exhausted errors",
			);
		});

		it("still calls markUsageLimitReached for regular rate_limit errors", async () => {
			const { deps, markUsageLimitReached } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("429 Too Many Requests");

			await handler.handleRetryableError(msg);

			assert.equal(
				markUsageLimitReached.mock.calls.length,
				1,
				"markUsageLimitReached should be called for rate_limit errors",
			);
		});

		it("still tries cross-provider fallback for quota_exhausted without credential backoff", async () => {
			const fallbackModel = createMockModel("openai", "gpt-4o");
			const { deps, markUsageLimitReached, continueFn } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false,
				fallbackResult: { model: fallbackModel, chainName: "coding", reason: "cross-provider fallback" },
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "should retry with fallback provider");
			assert.equal(
				markUsageLimitReached.mock.calls.length,
				0,
				"should NOT back off credentials before trying fallback",
			);
		});
	});
});
