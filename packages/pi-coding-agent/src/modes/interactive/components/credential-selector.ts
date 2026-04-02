import { Container, getEditorKeybindings, Spacer, TruncatedText } from "@gsd/pi-tui";
import type { AuthCredentialStatus } from "../../../core/auth-storage.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export class CredentialSelectorComponent extends Container {
	private listContainer: Container;
	private credentials: AuthCredentialStatus[] = [];
	private selectedIndex = 0;

	constructor(
		private provider: string,
		credentials: AuthCredentialStatus[],
		private onSelectCallback: (credentialId: string) => void,
		private onCancelCallback: () => void,
		private title: string = `Select ${provider} account to remove:`,
	) {
		super();

		this.credentials = credentials;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(this.title)));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		for (let i = 0; i < this.credentials.length; i++) {
			const credential = this.credentials[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const name = isSelected ? theme.fg("accent", credential.label) : credential.label;
			const badges: string[] = [];
			badges.push(theme.fg("muted", `[${credential.type === "oauth" ? "subscription" : "api key"}]`));
			if (credential.isActive) badges.push(theme.fg("success", "[active]"));
			if (credential.isPreferred && !credential.isActive) badges.push(theme.fg("accent", "[default]"));
			if (credential.isBackedOff) badges.push(theme.fg("warning", "[cooling]"));
			this.listContainer.addChild(new TruncatedText(`${prefix}${name} ${badges.join(" ")}`, 0, 0));
		}

		if (this.credentials.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "  No accounts configured"), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = Math.min(this.credentials.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "selectConfirm")) {
			const credential = this.credentials[this.selectedIndex];
			if (credential) {
				this.onSelectCallback(credential.id);
			}
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
	}
}
