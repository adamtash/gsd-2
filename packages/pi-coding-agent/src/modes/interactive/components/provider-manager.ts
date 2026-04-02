/**
 * TUI component for managing provider configurations.
 * Two-level view: provider list and account detail with scrolling.
 * Supports add/remove accounts, set default, and model discovery.
 */

import {
	Container,
	type Focusable,
	getEditorKeybindings,
	Spacer,
	type TUI,
	TruncatedText,
} from "@gsd/pi-tui";
import type { AuthCredentialStatus, AuthStorage } from "../../../core/auth-storage.js";
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

type ViewMode = "providers" | "accounts";

export interface ProviderManagerCallbacks {
	onDone: () => void;
	onDiscover: (provider: string) => void;
	onSetActive: (provider: string, credentialId: string) => void;
	onRemoveAccount: (provider: string, credentialId: string) => void;
	onAddAccount: (provider: string) => void;
	onAddApiKey: (provider: string) => void;
	onSetupToken: (provider: string) => void;
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
	private scrollOffset = 0;
	private viewMode: ViewMode = "providers";
	private activeProvider: string | null = null;
	private accounts: AuthCredentialStatus[] = [];
	private accountSelectedIndex = 0;
	private accountScrollOffset = 0;
	private listContainer: Container;
	private headerContainer: Container;
	private hintsContainer: Container;
	private tui: TUI;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private callbacks: ProviderManagerCallbacks;

	/** Maximum visible items in scrollable list area */
	private get maxVisibleItems(): number {
		// Reserve space for header, hints, borders, spacers
		return Math.max(3, Math.floor(this.tui.terminal.rows / 2) - 4);
	}

	constructor(
		tui: TUI,
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
		callbacks: ProviderManagerCallbacks,
	) {
		super();

		this.tui = tui;
		this.authStorage = authStorage;
		this.modelRegistry = modelRegistry;
		this.callbacks = callbacks;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.headerContainer = new Container();
		this.addChild(this.headerContainer);

		this.hintsContainer = new Container();
		this.addChild(this.hintsContainer);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.loadProviders();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}

	// Legacy constructor support for backward compatibility
	static create(
		tui: TUI,
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
		onDone: () => void,
		onDiscover: (provider: string) => void,
		onSetActive: (provider: string, credentialId: string) => void,
		onRemoveAccount: (provider: string, credentialId: string) => void,
		onAddAccount?: (provider: string) => void,
		onAddApiKey?: (provider: string) => void,
		onSetupToken?: (provider: string) => void,
	): ProviderManagerComponent {
		return new ProviderManagerComponent(tui, authStorage, modelRegistry, {
			onDone,
			onDiscover,
			onSetActive,
			onRemoveAccount,
			onAddAccount: onAddAccount ?? (() => {}),
			onAddApiKey: onAddApiKey ?? (() => {}),
			onSetupToken: onSetupToken ?? (() => {}),
		});
	}

	/** Refresh data and re-render (called after external changes like login/remove) */
	refresh(): void {
		this.loadProviders();
		if (this.viewMode === "accounts" && this.activeProvider) {
			this.loadAccounts(this.activeProvider);
		}
		this.updateHeader();
		this.updateHints();
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

	private formatAccountStatus(account: AuthCredentialStatus): string {
		const parts: string[] = [];
		if (account.isActive) {
			parts.push(theme.fg("success", "active"));
		}
		if (account.isPreferred) {
			parts.push(theme.fg("accent", "default"));
		}
		if (account.isBackedOff) {
			const secs = Math.ceil(account.backoffRemainingMs / 1000);
			parts.push(theme.fg("warning", `cooling ${secs}s`));
		}
		const typeLabel = account.type === "oauth" ? "oauth" : "api-key";
		parts.push(theme.fg("dim", typeLabel));
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
		this.clampIndex("providers");
	}

	private loadAccounts(provider: string): void {
		this.accounts = this.authStorage.getCredentialPool(provider);
		this.clampIndex("accounts");
	}

	private clampIndex(mode: ViewMode): void {
		if (mode === "providers") {
			if (this.providers.length === 0) {
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				return;
			}
			this.selectedIndex = Math.min(this.selectedIndex, this.providers.length - 1);
			this.ensureVisible("providers");
		} else {
			if (this.accounts.length === 0) {
				this.accountSelectedIndex = 0;
				this.accountScrollOffset = 0;
				return;
			}
			this.accountSelectedIndex = Math.min(this.accountSelectedIndex, this.accounts.length - 1);
			this.ensureVisible("accounts");
		}
	}

	private ensureVisible(mode: ViewMode): void {
		const maxVisible = this.maxVisibleItems;
		if (mode === "providers") {
			if (this.selectedIndex < this.scrollOffset) {
				this.scrollOffset = this.selectedIndex;
			} else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
				this.scrollOffset = this.selectedIndex - maxVisible + 1;
			}
		} else {
			if (this.accountSelectedIndex < this.accountScrollOffset) {
				this.accountScrollOffset = this.accountSelectedIndex;
			} else if (this.accountSelectedIndex >= this.accountScrollOffset + maxVisible) {
				this.accountScrollOffset = this.accountSelectedIndex - maxVisible + 1;
			}
		}
	}

	private updateHeader(): void {
		this.headerContainer.clear();
		if (this.viewMode === "providers") {
			this.headerContainer.addChild(new TruncatedText(theme.bold("Providers"), 0, 0));
			this.headerContainer.addChild(new TruncatedText(theme.fg("muted", "Manage accounts, defaults, and model discovery."), 0, 0));
		} else {
			const provider = this.activeProvider ?? "Unknown";
			this.headerContainer.addChild(new TruncatedText(theme.bold(`${provider} Accounts`), 0, 0));
			const providerInfo = this.providers.find((p) => p.name === provider);
			const subtitle = providerInfo
				? `${providerInfo.accountCount} account${providerInfo.accountCount === 1 ? "" : "s"}, ${providerInfo.modelCount} model${providerInfo.modelCount === 1 ? "" : "s"}`
				: "Manage credentials for this provider";
			this.headerContainer.addChild(new TruncatedText(theme.fg("muted", subtitle), 0, 0));
		}
	}

	private updateHints(): void {
		this.hintsContainer.clear();
		if (this.viewMode === "providers") {
			const hints = [
				rawKeyHint("enter", "accounts"),
				rawKeyHint("d", "discover"),
				rawKeyHint("+", "add account"),
				rawKeyHint("k", "add API key"),
				rawKeyHint("t", "setup token"),
				rawKeyHint("esc", "close"),
			].join("  ");
			this.hintsContainer.addChild(new TruncatedText(hints, 0, 0));
		} else {
			const hints = [
				rawKeyHint("a", "set default"),
				rawKeyHint("r", "remove"),
				rawKeyHint("+", "add account"),
				rawKeyHint("k", "add API key"),
				rawKeyHint("t", "setup token"),
				rawKeyHint("esc", "back"),
			].join("  ");
			this.hintsContainer.addChild(new TruncatedText(hints, 0, 0));
		}
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.viewMode === "providers") {
			this.renderProviderList();
		} else {
			this.renderAccountList();
		}
	}

	private renderProviderList(): void {
		if (this.providers.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "  No providers available"), 0, 0));
			return;
		}

		const maxVisible = this.maxVisibleItems;
		const end = Math.min(this.scrollOffset + maxVisible, this.providers.length);

		// Scroll up indicator
		if (this.scrollOffset > 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("dim", `  ↑ ${this.scrollOffset} more`), 0, 0));
		}

		for (let i = this.scrollOffset; i < end; i++) {
			const p = this.providers[i];
			const isSelected = i === this.selectedIndex;

			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			const nameText = isSelected ? theme.fg("accent", p.name) : theme.bold(p.name);
			const connectionText = p.hasAuth ? theme.fg("success", "connected") : theme.fg("dim", "available");

			this.listContainer.addChild(new TruncatedText(`${prefix}${nameText} ${connectionText}`, 0, 0));
			this.listContainer.addChild(new TruncatedText(`   ${this.formatProviderSummary(p)}`, 0, 0));
			if (i < end - 1) {
				this.listContainer.addChild(new Spacer(1));
			}
		}

		// Scroll down indicator
		const remaining = this.providers.length - end;
		if (remaining > 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("dim", `  ↓ ${remaining} more`), 0, 0));
		}
	}

	private renderAccountList(): void {
		if (this.accounts.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "  No accounts configured"), 0, 0));
			this.listContainer.addChild(new TruncatedText(theme.fg("dim", "  Press + to add an OAuth account, or k to add an API key"), 0, 0));
			return;
		}

		const maxVisible = this.maxVisibleItems;
		const end = Math.min(this.accountScrollOffset + maxVisible, this.accounts.length);

		// Scroll up indicator
		if (this.accountScrollOffset > 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("dim", `  ↑ ${this.accountScrollOffset} more`), 0, 0));
		}

		for (let i = this.accountScrollOffset; i < end; i++) {
			const account = this.accounts[i];
			const isSelected = i === this.accountSelectedIndex;

			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			const labelText = isSelected ? theme.fg("accent", account.label) : theme.bold(account.label);
			const activeIndicator = account.isActive ? theme.fg("success", " ●") : "";

			this.listContainer.addChild(new TruncatedText(`${prefix}${labelText}${activeIndicator}`, 0, 0));
			this.listContainer.addChild(new TruncatedText(`   ${this.formatAccountStatus(account)}`, 0, 0));
			if (i < end - 1) {
				this.listContainer.addChild(new Spacer(1));
			}
		}

		// Scroll down indicator
		const remaining = this.accounts.length - end;
		if (remaining > 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("dim", `  ↓ ${remaining} more`), 0, 0));
		}
	}

	private moveUp(): void {
		if (this.viewMode === "providers") {
			if (this.providers.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.providers.length - 1 : this.selectedIndex - 1;
			this.ensureVisible("providers");
		} else {
			if (this.accounts.length === 0) return;
			this.accountSelectedIndex = this.accountSelectedIndex === 0 ? this.accounts.length - 1 : this.accountSelectedIndex - 1;
			this.ensureVisible("accounts");
		}
		this.updateList();
		this.tui.requestRender();
	}

	private moveDown(): void {
		if (this.viewMode === "providers") {
			if (this.providers.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.providers.length - 1 ? 0 : this.selectedIndex + 1;
			this.ensureVisible("providers");
		} else {
			if (this.accounts.length === 0) return;
			this.accountSelectedIndex = this.accountSelectedIndex === this.accounts.length - 1 ? 0 : this.accountSelectedIndex + 1;
			this.ensureVisible("accounts");
		}
		this.updateList();
		this.tui.requestRender();
	}

	private enterAccountView(): void {
		const provider = this.providers[this.selectedIndex];
		if (!provider) return;
		this.activeProvider = provider.name;
		this.viewMode = "accounts";
		this.accountSelectedIndex = 0;
		this.accountScrollOffset = 0;
		this.loadAccounts(provider.name);
		this.updateHeader();
		this.updateHints();
		this.updateList();
		this.tui.requestRender();
	}

	private exitAccountView(): void {
		this.viewMode = "providers";
		this.activeProvider = null;
		this.accounts = [];
		this.loadProviders();
		this.updateHeader();
		this.updateHints();
		this.updateList();
		this.tui.requestRender();
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			this.moveUp();
		} else if (kb.matches(keyData, "selectDown")) {
			this.moveDown();
		} else if (kb.matches(keyData, "selectCancel")) {
			if (this.viewMode === "accounts") {
				this.exitAccountView();
			} else {
				this.callbacks.onDone();
			}
		} else if (kb.matches(keyData, "selectConfirm")) {
			if (this.viewMode === "providers") {
				this.enterAccountView();
			} else {
				// In account view, Enter sets the selected account as default
				const account = this.accounts[this.accountSelectedIndex];
				if (account && this.activeProvider) {
					this.callbacks.onSetActive(this.activeProvider, account.id);
				}
			}
		} else if (keyData === "d" || keyData === "D") {
			if (this.viewMode === "providers") {
				const provider = this.providers[this.selectedIndex];
				if (provider?.supportsDiscovery) {
					this.callbacks.onDiscover(provider.name);
				}
			}
		} else if (keyData === "a" || keyData === "A") {
			if (this.viewMode === "accounts") {
				const account = this.accounts[this.accountSelectedIndex];
				if (account && this.activeProvider) {
					this.callbacks.onSetActive(this.activeProvider, account.id);
				}
			}
		} else if (keyData === "r" || keyData === "R") {
			if (this.viewMode === "accounts") {
				const account = this.accounts[this.accountSelectedIndex];
				if (account && this.activeProvider) {
					this.callbacks.onRemoveAccount(this.activeProvider, account.id);
				}
			} else {
				// In provider view, 'r' removes all accounts for the provider
				const provider = this.providers[this.selectedIndex];
				if (provider?.accountCount > 0) {
					// Remove the first credential as a signal to the handler
					const pool = this.authStorage.getCredentialPool(provider.name);
					if (pool.length > 0) {
						this.callbacks.onRemoveAccount(provider.name, pool[0].id);
					}
				}
			}
		} else if (keyData === "+" || keyData === "=") {
			const providerName = this.viewMode === "accounts"
				? this.activeProvider
				: this.providers[this.selectedIndex]?.name;
			if (providerName) {
				this.callbacks.onAddAccount(providerName);
			}
		} else if (keyData === "k" || keyData === "K") {
			const providerName = this.viewMode === "accounts"
				? this.activeProvider
				: this.providers[this.selectedIndex]?.name;
			if (providerName) {
				this.callbacks.onAddApiKey(providerName);
			}
		} else if (keyData === "t" || keyData === "T") {
			const providerName = this.viewMode === "accounts"
				? this.activeProvider
				: this.providers[this.selectedIndex]?.name;
			if (providerName) {
				this.callbacks.onSetupToken(providerName);
			}
		}
	}
}
