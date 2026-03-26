// GSD Provider Fallback Resolver
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * FallbackResolver - Cross-provider fallback when rate/quota limits are hit.
 *
 * When a provider's credentials are all exhausted, this resolver finds the next
 * available provider+model from a user-configured fallback chain. It also handles
 * restoration: checking if a higher-priority provider has recovered before each request.
 */

import type { Api, Model } from "@gsd/pi-ai";
import type { AuthStorage, UsageLimitErrorType } from "./auth-storage.js";
import type { ModelRegistry } from "./model-registry.js";
import type { FallbackChainEntry, SettingsManager } from "./settings-manager.js";

export interface FallbackResult {
	model: Model<Api>;
	chainName: string;
	reason: string;
}

export class FallbackResolver {
	constructor(
		private settingsManager: SettingsManager,
		private authStorage: AuthStorage,
		private modelRegistry: ModelRegistry,
	) {}

	/**
	 * Find the next available fallback for a model that just failed.
	 * First searches explicit chains (when fallback.enabled = true in settings).
	 * If no chain match is found, auto-discovers any other provider that has
	 * non-exhausted credentials in auth storage (zero-config fallback).
	 *
	 * @returns FallbackResult if a fallback is available, null otherwise
	 */
	async findFallback(
		currentModel: Model<Api>,
		errorType: UsageLimitErrorType,
	): Promise<FallbackResult | null> {
		const { enabled, chains } = this.settingsManager.getFallbackSettings();

		// Mark the current provider as exhausted at the provider level
		this.authStorage.markProviderExhausted(currentModel.provider, errorType);

		// If explicit chains are configured and enabled, search them first
		if (enabled) {
			for (const [chainName, entries] of Object.entries(chains)) {
				const currentIndex = this._findChainIndex(entries, currentModel);

				if (currentIndex === -1) continue;

				// Try entries after the current one (already sorted by priority)
				const result = await this._findAvailableInChain(chainName, entries, currentIndex + 1);
				if (result) return result;

				// Wrap around: try entries before the current one
				const wrapResult = await this._findAvailableInChain(chainName, entries, 0, currentIndex);
				if (wrapResult) return wrapResult;
			}
		}

		// Auto-discover: try any other provider with available credentials
		return this._autoDiscoverFallback(currentModel);
	}

	/**
	 * Check if a higher-priority provider in the chain has recovered.
	 * Called before each LLM request to restore the best available provider.
	 *
	 * @returns FallbackResult if a better provider is available, null if current is best
	 */
	async checkForRestoration(currentModel: Model<Api>): Promise<FallbackResult | null> {
		const { enabled, chains } = this.settingsManager.getFallbackSettings();
		if (!enabled) return null;

		for (const [chainName, entries] of Object.entries(chains)) {
			const currentIndex = this._findChainIndex(entries, currentModel);

			if (currentIndex === -1) continue;

			// Only check entries with higher priority (lower index = higher priority)
			if (currentIndex === 0) continue; // Already at highest priority

			const result = await this._findAvailableInChain(chainName, entries, 0, currentIndex);
			if (result) {
				return {
					...result,
					reason: `${result.model.provider}/${result.model.id} recovered, restoring from fallback`,
				};
			}
		}

		return null;
	}

	/**
	 * Get the best available model from a named chain.
	 * Useful for initial model selection.
	 */
	async getBestAvailable(chainName: string): Promise<FallbackResult | null> {
		const { enabled, chains } = this.settingsManager.getFallbackSettings();
		if (!enabled) return null;

		const entries = chains[chainName];
		if (!entries || entries.length === 0) return null;

		return this._findAvailableInChain(chainName, entries, 0);
	}

	/**
	 * Find the chain(s) a model belongs to.
	 */
	findChainsForModel(provider: string, modelId: string): string[] {
		const { chains } = this.settingsManager.getFallbackSettings();
		const result: string[] = [];

		for (const [chainName, entries] of Object.entries(chains)) {
			if (entries.some((e) => e.provider === provider)) {
				result.push(chainName);
			}
		}

		return result;
	}

	/**
	 * Auto-discover a fallback provider by scanning all providers in auth storage.
	 * Returns the first provider (other than the current one) that has available
	 * credentials and a resolvable model in the model registry.
	 * This enables zero-config cross-provider fallback when no explicit chains
	 * are configured.
	 */
	private async _autoDiscoverFallback(currentModel: Model<Api>): Promise<FallbackResult | null> {
		const allProviders = Object.keys(this.authStorage.getAll());
		for (const provider of allProviders) {
			if (provider === currentModel.provider) continue;
			if (!this.authStorage.isProviderAvailable(provider)) continue;
			if (!this.authStorage.hasAuth(provider)) continue;

			const model = this.modelRegistry.getPreferredModelForProvider(provider);
			if (!model) continue;

			return {
				model,
				chainName: "auto",
				reason: `auto-fallback to ${provider}/${model.id}`,
			};
		}
		return null;
	}

	private _findChainIndex(entries: FallbackChainEntry[], currentModel: Model<Api>): number {
		const exactIndex = entries.findIndex(
			(entry) => entry.provider === currentModel.provider && entry.model === currentModel.id,
		);
		if (exactIndex !== -1) return exactIndex;

		return entries.findIndex((entry) => entry.provider === currentModel.provider);
	}

	/**
	 * Search a chain for the first available entry starting from startIndex.
	 */
	private async _findAvailableInChain(
		chainName: string,
		entries: FallbackChainEntry[],
		startIndex: number,
		endIndex?: number,
	): Promise<FallbackResult | null> {
		const end = endIndex ?? entries.length;

		for (let i = startIndex; i < end; i++) {
			const entry = entries[i];

			// Check provider-level backoff
			if (!this.authStorage.isProviderAvailable(entry.provider)) {
				continue;
			}

			// Resolve an appropriate model for the target provider.
			// Prefer the chain's explicit model, then fall back to the provider default.
			const model = this.modelRegistry.getPreferredModelForProvider(entry.provider, entry.model);
			if (!model) continue;

			// Check if provider is request-ready for fallback (authMode-aware)
			if (!this.modelRegistry.isProviderRequestReady(entry.provider)) continue;

			return {
				model,
				chainName,
				reason: `falling back to ${entry.provider}/${model.id}`,
			};
		}

		return null;
	}
}
