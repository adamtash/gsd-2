/**
 * TUI component for managing provider configurations.
 * Shows providers with auth status, discovery support, and model counts.
 */

import {
	Container,
	type Focusable,
	getEditorKeybindings,
	Spacer,
	type TUI,
	TruncatedText,
} from "@gsd/pi-tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import { getDiscoverableProviders } from "../../../core/model-discovery.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { rawKeyHint } from "./keybinding-hints.js";

interface ProviderInfo {
	name: string;
	hasAuth: boolean;
	supportsDiscovery: boolean;
	modelCount: number;
	accountCount: number;
	backedOffCount: number;
}

export class ProviderManagerComponent extends Container implements Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	private providers: ProviderInfo[] = [];
	private selectedIndex = 0;
	private listContainer: Container;
	private tui: TUI;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private onDone: () => void;
	private onDiscover: (provider: string) => void;
	private onSetActive: (provider: string) => void;
	private onRemoveAccount: (provider: string) => void;

	constructor(
		tui: TUI,
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
		onDone: () => void,
		onDiscover: (provider: string) => void,
		onSetActive: (provider: string) => void,
		onRemoveAccount: (provider: string) => void,
	) {
		super();

		this.tui = tui;
		this.authStorage = authStorage;
		this.modelRegistry = modelRegistry;
		this.onDone = onDone;
		this.onDiscover = onDiscover;
		this.onSetActive = onSetActive;
		this.onRemoveAccount = onRemoveAccount;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Providers"), 0, 0));
		this.addChild(new TruncatedText(theme.fg("muted", "Manage accounts, defaults, and model discovery."), 0, 0));
		this.addChild(new Spacer(1));

		const hints = [
			rawKeyHint("d", "discover"),
			rawKeyHint("a", "set default"),
			rawKeyHint("r", "remove account"),
			rawKeyHint("esc", "close"),
		].join("  ");
		this.addChild(new TruncatedText(hints, 0, 0));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.loadProviders();
		this.updateList();
	}

	private formatProviderSummary(provider: ProviderInfo): string {
		const parts = [theme.fg("muted", `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`)];
		if (provider.accountCount > 0) {
			parts.push(theme.fg("muted", `${provider.accountCount} account${provider.accountCount === 1 ? "" : "s"}`));
		}
		if (provider.backedOffCount > 0) {
			parts.push(theme.fg("warning", `${provider.backedOffCount} cooling`));
		}
		if (provider.supportsDiscovery) {
			parts.push(theme.fg("accent", "discover"));
		}
		if (!provider.hasAuth) {
			parts.push(theme.fg("dim", "not configured"));
		}
		return parts.join(theme.fg("muted", " • "));
	}

	private loadProviders(): void {
		const discoverableSet = new Set(getDiscoverableProviders());
		const allModels = this.modelRegistry.getAll();

		// Group models by provider
		const providerModelCounts = new Map<string, number>();
		for (const model of allModels) {
			providerModelCounts.set(model.provider, (providerModelCounts.get(model.provider) ?? 0) + 1);
		}

		// Build provider list from all known providers
		const providerNames = new Set([
			...providerModelCounts.keys(),
			...discoverableSet,
		]);

		this.providers = Array.from(providerNames)
			.sort()
			.map((name) => {
				const credentialPool = this.authStorage.getCredentialPool(name);
				return {
					name,
					hasAuth: this.authStorage.hasAuth(name),
					supportsDiscovery: discoverableSet.has(name),
					modelCount: providerModelCounts.get(name) ?? 0,
					accountCount: credentialPool.length,
					backedOffCount: credentialPool.filter((credential) => credential.isBackedOff).length,
				};
			});
	}

	private updateList(): void {
		this.listContainer.clear();

		for (let i = 0; i < this.providers.length; i++) {
			const p = this.providers[i];
			const isSelected = i === this.selectedIndex;

			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			const nameText = isSelected ? theme.fg("accent", p.name) : theme.bold(p.name);
			const connectionText = p.hasAuth ? theme.fg("success", "connected") : theme.fg("dim", "available");

			this.listContainer.addChild(new TruncatedText(`${prefix}${nameText} ${connectionText}`, 0, 0));
			this.listContainer.addChild(new TruncatedText(`   ${this.formatProviderSummary(p)}`, 0, 0));
			if (i < this.providers.length - 1) {
				this.listContainer.addChild(new Spacer(1));
			}
		}

		if (this.providers.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "  No providers available"), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			if (this.providers.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.providers.length - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "selectDown")) {
			if (this.providers.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.providers.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onDone();
		} else if (keyData === "d" || keyData === "D") {
			const provider = this.providers[this.selectedIndex];
			if (provider?.supportsDiscovery) {
				this.onDiscover(provider.name);
			}
		} else if (keyData === "a" || keyData === "A") {
			const provider = this.providers[this.selectedIndex];
			if (provider?.accountCount > 0) {
				this.onSetActive(provider.name);
			}
		} else if (keyData === "r" || keyData === "R") {
			const provider = this.providers[this.selectedIndex];
			if (provider?.accountCount > 0) {
				this.onRemoveAccount(provider.name);
			}
		}
	}
}
