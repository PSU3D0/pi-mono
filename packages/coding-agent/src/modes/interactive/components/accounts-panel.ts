/**
 * Accounts panel component - displays and manages Antigravity Google accounts.
 *
 * Shows:
 * - Account email and status (enabled/disabled/cooling down)
 * - Health score and rate limit status
 * - Active family assignments (claude/gemini)
 * - Options to add, enable/disable, or remove accounts
 */

import type { AccountInfo } from "@mariozechner/pi-ai/antigravity-account-pool";
import { Container, getEditorKeybindings, Spacer, TruncatedText } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export type AccountAction = "add" | "toggle" | "remove" | "close";

export class AccountsPanelComponent extends Container {
	private listContainer: Container;
	private accounts: AccountInfo[] = [];
	private selectedIndex: number = 0;

	constructor(
		accounts: AccountInfo[],
		private onAction: (action: AccountAction, accountIndex?: number) => void,
		private onClose: () => void,
	) {
		super();
		this.accounts = accounts;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Antigravity Accounts")));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(theme.fg("muted", "↑↓ Navigate  Enter: Toggle  a: Add Account  d: Remove  Esc: Close")),
		);
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	updateAccounts(accounts: AccountInfo[]): void {
		this.accounts = accounts;
		if (this.selectedIndex >= this.accounts.length + 1) {
			this.selectedIndex = Math.max(0, this.accounts.length);
		}
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.accounts.length === 0) {
			this.listContainer.addChild(
				new TruncatedText(theme.fg("muted", "  No accounts configured. Press 'a' to add one.")),
			);
			return;
		}

		for (let i = 0; i < this.accounts.length; i++) {
			const acc = this.accounts[i]!;
			const isSelected = i === this.selectedIndex;

			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";

			// Status indicator
			let status: string;
			if (!acc.enabled) {
				status = theme.fg("error", "✗ disabled");
			} else if (acc.isCoolingDown) {
				status = theme.fg("warning", "⏸ cooling down");
			} else if (acc.isRateLimited) {
				status = theme.fg("warning", "⚠ rate limited");
			} else {
				status = theme.fg("success", "● active");
			}

			// Health bar
			const healthPct = Math.round(acc.healthScore);
			const healthColor = healthPct >= 70 ? "success" : healthPct >= 50 ? "warning" : "error";
			const healthBar = theme.fg(healthColor, `${healthPct}%`);

			// Email or placeholder
			const email = acc.email ?? `Account ${acc.index + 1}`;
			const emailText = isSelected ? theme.fg("accent", email) : email;

			// Active families
			const families =
				acc.activeForFamilies.length > 0 ? theme.fg("accent", ` [${acc.activeForFamilies.join(", ")}]`) : "";

			// Last Used
			let lastUsedStr = "Never";
			if (acc.lastUsed > 0) {
				const diffMs = Date.now() - acc.lastUsed;
				if (diffMs < 60000) lastUsedStr = "< 1m";
				else if (diffMs < 3600000) lastUsedStr = `${Math.floor(diffMs / 60000)}m`;
				else if (diffMs < 86400000) lastUsedStr = `${Math.floor(diffMs / 3600000)}h`;
				else lastUsedStr = `${Math.floor(diffMs / 86400000)}d`;
			}
			const lastUsedText = theme.fg("dim", ` Used:${lastUsedStr}`);

			// Rate limit info
			const rlCount = acc.rateLimitKeys.length;
			const rlInfo = rlCount > 0 ? theme.fg("warning", ` (${rlCount} rate limits)`) : "";

			const line = `${prefix}${emailText} ${status} HP:${healthBar}${lastUsedText}${families}${rlInfo}`;
			this.listContainer.addChild(new TruncatedText(line));
		}

		// Summary line
		this.listContainer.addChild(new Spacer(1));
		const enabledCount = this.accounts.filter((a) => a.enabled).length;
		const totalCount = this.accounts.length;
		this.listContainer.addChild(
			new TruncatedText(theme.fg("muted", `  ${enabledCount}/${totalCount} accounts enabled`)),
		);
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = Math.min(this.accounts.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "selectConfirm")) {
			// Enter: Toggle enable/disable
			if (this.accounts.length > 0 && this.selectedIndex < this.accounts.length) {
				this.onAction("toggle", this.accounts[this.selectedIndex]!.index);
			}
		} else if (keyData === "a" || keyData === "A") {
			this.onAction("add");
		} else if (keyData === "d" || keyData === "D") {
			if (this.accounts.length > 0 && this.selectedIndex < this.accounts.length) {
				this.onAction("remove", this.accounts[this.selectedIndex]!.index);
			}
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onClose();
		}
	}
}
