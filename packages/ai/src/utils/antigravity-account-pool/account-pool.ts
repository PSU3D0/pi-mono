/**
 * AntigravityAccountPool - Multi-account manager with intelligent rotation.
 *
 * Core responsibilities:
 * - Manage N Google accounts with independent credentials
 * - Select accounts using sticky-with-fallback strategy (use same until 429, then switch)
 * - Track rate limits per-account, per-model, per-header-style
 * - Generate per-account device fingerprints for ban mitigation
 * - Health scoring: penalize failing accounts, reward successful ones
 * - Persist state to disk for cross-session continuity
 *
 * Integration with Pi:
 * - Replaces single-credential auth for google-antigravity provider
 * - getCredentials() returns { accessToken, projectId, headers } for the best account
 * - markRateLimited() / markSuccess() called by the provider after each request
 */

import type { OAuthCredentials } from "../oauth/types.js";
import {
	buildFingerprintHeaders,
	generateFingerprint,
	MAX_FINGERPRINT_HISTORY,
	updateFingerprintVersion,
} from "./fingerprint.js";
import {
	calculateBackoffMs,
	clearExpiredRateLimits,
	getAvailableHeaderStyle,
	getQuotaKey,
	isRateLimitedForFamily,
	isRateLimitedForHeaderStyle,
	parseRateLimitReason,
} from "./rate-limits.js";
import { isValidStoredAccount, loadAccountPool, saveAccountPool } from "./storage.js";
import type {
	AccountInfo,
	AccountPoolStorage,
	AccountSelection,
	AccountSelectionStrategy,
	CooldownReason,
	DeviceFingerprint,
	FingerprintVersion,
	HeaderStyle,
	ModelFamily,
	PoolAccount,
	RateLimitReason,
	StoredAccount,
} from "./types.js";

// ============================================================================
// HEALTH SCORE CONSTANTS
// ============================================================================

const HEALTH_INITIAL = 70;
const HEALTH_SUCCESS_REWARD = 1;
const HEALTH_RATE_LIMIT_PENALTY = -10;
const HEALTH_FAILURE_PENALTY = -20;
const HEALTH_RECOVERY_PER_HOUR = 2;
const _HEALTH_MIN_USABLE = 50;
const HEALTH_MAX = 100;
const FAILURE_TTL_MS = 3_600_000; // 1 hour

// ============================================================================
// TOKEN REFRESH
// ============================================================================

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

const ACCESS_TOKEN_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

// ============================================================================
// ACCOUNT POOL
// ============================================================================

export class AntigravityAccountPool {
	private accounts: PoolAccount[] = [];
	private activeIndexByFamily: Record<ModelFamily, number> = {
		claude: -1,
		gemini: -1,
	};
	private cursor = 0;
	private savePending = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Create a new account pool.
	 * @param storagePath - Path to persist account pool state
	 */
	constructor(private storagePath: string) {}

	// ========================================================================
	// LIFECYCLE
	// ========================================================================

	/**
	 * Load accounts from disk storage.
	 */
	load(): void {
		const stored = loadAccountPool(this.storagePath);
		if (!stored || stored.accounts.length === 0) {
			this.accounts = [];
			this.activeIndexByFamily = { claude: -1, gemini: -1 };
			return;
		}

		this.accounts = stored.accounts.filter(isValidStoredAccount).map((acc, index) => this.hydrateAccount(acc, index));

		// Update fingerprint versions to current
		let versionUpdated = false;
		for (const account of this.accounts) {
			if (account.fingerprint && updateFingerprintVersion(account.fingerprint)) {
				versionUpdated = true;
			}
		}
		if (versionUpdated) {
			this.requestSave();
		}

		if (this.accounts.length > 0) {
			this.activeIndexByFamily.claude = Math.min(
				Math.max(0, stored.activeIndexByFamily?.claude ?? 0),
				this.accounts.length - 1,
			);
			this.activeIndexByFamily.gemini = Math.min(
				Math.max(0, stored.activeIndexByFamily?.gemini ?? 0),
				this.accounts.length - 1,
			);
		}
	}

	/**
	 * Save current state to disk (debounced, 1s delay).
	 */
	requestSave(): void {
		if (this.savePending) return;
		this.savePending = true;
		this.saveTimer = setTimeout(() => {
			this.executeSave();
		}, 1000);
	}

	/**
	 * Force immediate save to disk.
	 */
	saveNow(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.savePending = false;
		this.executeSave();
	}

	private executeSave(): void {
		this.savePending = false;
		this.saveTimer = null;

		const storage: AccountPoolStorage = {
			version: 1,
			accounts: this.accounts.map((a) => this.dehydrateAccount(a)),
			activeIndex: Math.max(0, this.activeIndexByFamily.claude),
			activeIndexByFamily: { ...this.activeIndexByFamily },
		};

		try {
			saveAccountPool(this.storagePath, storage);
		} catch {
			// Best-effort persistence
		}
	}

	// ========================================================================
	// ACCOUNT MANAGEMENT
	// ========================================================================

	/**
	 * Add a new account to the pool from OAuth credentials.
	 */
	addAccount(credentials: OAuthCredentials & { projectId?: string; email?: string }): PoolAccount {
		// Check for duplicate (same refresh token)
		const existing = this.accounts.find((a) => a.refreshToken === credentials.refresh);
		if (existing) {
			// Update existing account
			existing.accessToken = credentials.access;
			existing.accessTokenExpires = credentials.expires;
			existing.projectId = (credentials as any).projectId ?? existing.projectId;
			existing.email = (credentials as any).email ?? existing.email;
			existing.enabled = true;
			this.requestSave();
			return existing;
		}

		const account: PoolAccount = {
			index: this.accounts.length,
			email: (credentials as any).email,
			refreshToken: credentials.refresh,
			projectId: (credentials as any).projectId,
			accessToken: credentials.access,
			accessTokenExpires: credentials.expires,
			addedAt: Date.now(),
			lastUsed: 0,
			enabled: true,
			rateLimitResetTimes: {},
			consecutiveFailures: 0,
			fingerprint: generateFingerprint(),
			healthScore: HEALTH_INITIAL,
		};

		this.accounts.push(account);

		// Set as active for families that don't have one
		if (this.activeIndexByFamily.claude < 0) {
			this.activeIndexByFamily.claude = account.index;
		}
		if (this.activeIndexByFamily.gemini < 0) {
			this.activeIndexByFamily.gemini = account.index;
		}

		this.requestSave();
		return account;
	}

	/**
	 * Remove an account by index.
	 */
	removeAccount(index: number): boolean {
		if (index < 0 || index >= this.accounts.length) return false;

		this.accounts.splice(index, 1);

		// Reindex
		this.accounts.forEach((acc, i) => {
			acc.index = i;
		});

		// Fix cursors
		for (const family of ["claude", "gemini"] as ModelFamily[]) {
			if (this.activeIndexByFamily[family] >= this.accounts.length) {
				this.activeIndexByFamily[family] = this.accounts.length > 0 ? 0 : -1;
			} else if (this.activeIndexByFamily[family] > index) {
				this.activeIndexByFamily[family]--;
			}
		}

		this.requestSave();
		return true;
	}

	/**
	 * Enable or disable an account.
	 */
	setEnabled(index: number, enabled: boolean): boolean {
		const account = this.accounts[index];
		if (!account) return false;

		account.enabled = enabled;

		// If disabling active account, find a replacement
		if (!enabled) {
			for (const family of ["claude", "gemini"] as ModelFamily[]) {
				if (this.activeIndexByFamily[family] === index) {
					const next = this.accounts.find((a) => a.index !== index && a.enabled);
					this.activeIndexByFamily[family] = next?.index ?? -1;
				}
			}
		}

		this.requestSave();
		return true;
	}

	/**
	 * Get the total count of enabled accounts.
	 */
	getAccountCount(): number {
		return this.accounts.filter((a) => a.enabled).length;
	}

	/**
	 * Get all accounts count (including disabled).
	 */
	getTotalAccountCount(): number {
		return this.accounts.length;
	}

	/**
	 * Check if pool has any accounts.
	 */
	hasAccounts(): boolean {
		return this.accounts.length > 0;
	}

	/**
	 * Check if any account has available antigravity quota for the given family/model.
	 * Used by the provider to decide whether to rotate accounts or give up.
	 */
	hasAvailableAccount(family: ModelFamily, model?: string | null): boolean {
		return this.accounts.some((a) => {
			if (!a.enabled) return false;
			if (this.isAccountCoolingDown(a)) return false;
			clearExpiredRateLimits(a.rateLimitResetTimes);
			return !isRateLimitedForHeaderStyle(a.rateLimitResetTimes, family, "antigravity", model);
		});
	}

	/**
	 * Get account info for display purposes.
	 */
	getAccountsInfo(): AccountInfo[] {
		return this.accounts.map((a) => {
			clearExpiredRateLimits(a.rateLimitResetTimes);

			const activeForFamilies: ModelFamily[] = [];
			if (this.activeIndexByFamily.claude === a.index) activeForFamilies.push("claude");
			if (this.activeIndexByFamily.gemini === a.index) activeForFamilies.push("gemini");

			return {
				index: a.index,
				email: a.email,
				enabled: a.enabled,
				healthScore: this.getHealthScore(a),
				isRateLimited:
					isRateLimitedForFamily(a.rateLimitResetTimes, "gemini") &&
					isRateLimitedForFamily(a.rateLimitResetTimes, "claude"),
				isCoolingDown: this.isAccountCoolingDown(a),
				lastUsed: a.lastUsed,
				addedAt: a.addedAt,
				activeForFamilies,
				rateLimitKeys: Object.keys(a.rateLimitResetTimes).filter(
					(k) => Date.now() < (a.rateLimitResetTimes[k] ?? 0),
				),
			};
		});
	}

	// ========================================================================
	// ACCOUNT SELECTION
	// ========================================================================

	/**
	 * Get the best account for a request.
	 *
	 * Strategy: sticky-with-fallback
	 * 1. Use current active account for the family if it's available
	 * 2. If rate limited, switch to next available account
	 * 3. If switching, prefer accounts with higher health scores
	 * 4. Returns null if all accounts are exhausted
	 */
	selectAccount(
		family: ModelFamily,
		model?: string | null,
		strategy: AccountSelectionStrategy = "sticky",
	): AccountSelection | null {
		if (this.accounts.length === 0) return null;

		const enabledAccounts = this.accounts.filter((a) => a.enabled);
		if (enabledAccounts.length === 0) return null;

		if (strategy === "round-robin") {
			return this.selectRoundRobin(enabledAccounts, family, model);
		}

		// Sticky strategy (default)
		return this.selectSticky(enabledAccounts, family, model);
	}

	private selectSticky(accounts: PoolAccount[], family: ModelFamily, model?: string | null): AccountSelection | null {
		// Try current active account
		const currentIndex = this.activeIndexByFamily[family];
		const current = currentIndex >= 0 ? this.accounts[currentIndex] : null;

		if (current?.enabled && !this.isAccountCoolingDown(current)) {
			clearExpiredRateLimits(current.rateLimitResetTimes);

			const headerStyle = getAvailableHeaderStyle(current.rateLimitResetTimes, family, model);
			if (headerStyle) {
				return {
					account: current,
					headerStyle,
					switched: false,
				};
			}
		}

		// Current is unavailable - find best alternative
		const candidates = accounts
			.filter((a) => {
				if (this.isAccountCoolingDown(a)) return false;
				clearExpiredRateLimits(a.rateLimitResetTimes);
				return !isRateLimitedForFamily(a.rateLimitResetTimes, family, model);
			})
			.sort((a, b) => {
				// Sort by health score (higher is better), then by last used (older is better)
				const healthDiff = this.getHealthScore(b) - this.getHealthScore(a);
				if (healthDiff !== 0) return healthDiff;
				return a.lastUsed - b.lastUsed;
			});

		if (candidates.length === 0) return null;

		const selected = candidates[0]!;
		const headerStyle = getAvailableHeaderStyle(selected.rateLimitResetTimes, family, model);
		if (!headerStyle) return null;

		this.activeIndexByFamily[family] = selected.index;
		selected.lastSwitchReason = "rate-limit";

		return {
			account: selected,
			headerStyle,
			switched: true,
			switchReason: "rate-limit",
		};
	}

	private selectRoundRobin(
		accounts: PoolAccount[],
		family: ModelFamily,
		model?: string | null,
	): AccountSelection | null {
		const available = accounts.filter((a) => {
			if (this.isAccountCoolingDown(a)) return false;
			clearExpiredRateLimits(a.rateLimitResetTimes);
			return !isRateLimitedForFamily(a.rateLimitResetTimes, family, model);
		});

		if (available.length === 0) return null;

		const account = available[this.cursor % available.length]!;
		this.cursor++;

		const headerStyle = getAvailableHeaderStyle(account.rateLimitResetTimes, family, model);
		if (!headerStyle) return null;

		const switched = this.activeIndexByFamily[family] !== account.index;
		this.activeIndexByFamily[family] = account.index;

		return {
			account,
			headerStyle,
			switched,
			switchReason: switched ? "rotation" : undefined,
		};
	}

	// ========================================================================
	// REQUEST LIFECYCLE CALLBACKS
	// ========================================================================

	/**
	 * Mark a request as successful.
	 * Improves health score and resets consecutive failures.
	 */
	markSuccess(accountIndex: number): void {
		const account = this.accounts[accountIndex];
		if (!account) return;

		account.consecutiveFailures = 0;
		account.lastUsed = Date.now();
		account.healthScore = Math.min(HEALTH_MAX, this.getHealthScore(account) + HEALTH_SUCCESS_REWARD);
		this.requestSave();
	}

	/**
	 * Mark an account as rate limited.
	 * Applies backoff and switches to next account for the family.
	 */
	markRateLimited(
		accountIndex: number,
		family: ModelFamily,
		headerStyle: HeaderStyle,
		model: string | null | undefined,
		status: number,
		errorText: string,
		retryAfterMs?: number | null,
	): { backoffMs: number; reason: RateLimitReason } {
		const account = this.accounts[accountIndex];
		if (!account) return { backoffMs: 60_000, reason: "UNKNOWN" };

		const now = Date.now();

		// TTL-based reset of consecutive failures
		if (account.lastFailureTime && now - account.lastFailureTime > FAILURE_TTL_MS) {
			account.consecutiveFailures = 0;
		}

		account.consecutiveFailures++;
		account.lastFailureTime = now;
		account.healthScore = Math.max(0, this.getHealthScore(account) + HEALTH_RATE_LIMIT_PENALTY);

		const reason = parseRateLimitReason(undefined, errorText, status);
		const backoffMs = calculateBackoffMs(reason, account.consecutiveFailures - 1, retryAfterMs);

		const key = getQuotaKey(family, headerStyle, model);
		account.rateLimitResetTimes[key] = now + backoffMs;

		this.requestSave();
		return { backoffMs, reason };
	}

	/**
	 * Mark an account as having a non-rate-limit failure (auth error, etc.)
	 */
	markFailure(accountIndex: number): void {
		const account = this.accounts[accountIndex];
		if (!account) return;

		account.consecutiveFailures++;
		account.lastFailureTime = Date.now();
		account.healthScore = Math.max(0, this.getHealthScore(account) + HEALTH_FAILURE_PENALTY);
		this.requestSave();
	}

	/**
	 * Mark an account as cooling down (e.g., needs verification).
	 */
	markCoolingDown(accountIndex: number, cooldownMs: number, reason: CooldownReason): void {
		const account = this.accounts[accountIndex];
		if (!account) return;

		account.coolingDownUntil = Date.now() + cooldownMs;
		account.cooldownReason = reason;
		this.requestSave();
	}

	/**
	 * Clear all rate limits for a family (useful after manual reset).
	 */
	clearRateLimits(family: ModelFamily, model?: string | null): void {
		for (const account of this.accounts) {
			if (family === "claude") {
				delete account.rateLimitResetTimes.claude;
			} else {
				const keysToDelete = Object.keys(account.rateLimitResetTimes).filter(
					(k) => k.startsWith("gemini-antigravity") || (model && k.includes(model)),
				);
				for (const key of keysToDelete) {
					delete account.rateLimitResetTimes[key];
				}
			}
			account.consecutiveFailures = 0;
		}
		this.requestSave();
	}

	// ========================================================================
	// TOKEN REFRESH
	// ========================================================================

	/**
	 * Ensure an account has a valid access token.
	 * Refreshes if expired or missing.
	 */
	async ensureAccessToken(accountIndex: number): Promise<{ token: string; projectId: string } | null> {
		const account = this.accounts[accountIndex];
		if (!account) return null;

		// Check if token is still valid
		if (
			account.accessToken &&
			account.accessTokenExpires &&
			Date.now() < account.accessTokenExpires - ACCESS_TOKEN_BUFFER_MS
		) {
			return {
				token: account.accessToken,
				projectId: account.projectId ?? "",
			};
		}

		// Refresh the token
		try {
			const response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					client_secret: CLIENT_SECRET,
					refresh_token: account.refreshToken,
					grant_type: "refresh_token",
				}),
			});

			if (!response.ok) {
				const error = await response.text();
				// Auth failure - may need re-login
				if (response.status === 400 || response.status === 401) {
					this.markCoolingDown(accountIndex, 3_600_000, "auth-failure");
				}
				throw new Error(`Token refresh failed (${response.status}): ${error}`);
			}

			const data = (await response.json()) as {
				access_token: string;
				expires_in: number;
				refresh_token?: string;
			};

			account.accessToken = data.access_token;
			account.accessTokenExpires = Date.now() + data.expires_in * 1000;
			if (data.refresh_token) {
				account.refreshToken = data.refresh_token;
			}

			this.requestSave();

			return {
				token: account.accessToken,
				projectId: account.projectId ?? "",
			};
		} catch (_error) {
			this.markFailure(accountIndex);
			return null;
		}
	}

	/**
	 * Get credentials for a request: selects best account, ensures valid token,
	 * returns everything the provider needs.
	 */
	async getCredentials(
		family: ModelFamily,
		model?: string | null,
		strategy?: AccountSelectionStrategy,
	): Promise<{
		accountIndex: number;
		token: string;
		projectId: string;
		headers: Record<string, string>;
		headerStyle: HeaderStyle;
		switched: boolean;
	} | null> {
		const selection = this.selectAccount(family, model, strategy);
		if (!selection) return null;

		const tokenResult = await this.ensureAccessToken(selection.account.index);
		if (!tokenResult) {
			// Token refresh failed, try to find another account
			this.markCoolingDown(selection.account.index, 300_000, "auth-failure");

			const fallback = this.selectAccount(family, model, strategy);
			if (!fallback || fallback.account.index === selection.account.index) return null;

			const fallbackToken = await this.ensureAccessToken(fallback.account.index);
			if (!fallbackToken) return null;

			return {
				accountIndex: fallback.account.index,
				token: fallbackToken.token,
				projectId: fallbackToken.projectId,
				headers: buildFingerprintHeaders(fallback.account.fingerprint),
				headerStyle: fallback.headerStyle,
				switched: true,
			};
		}

		const headers = buildFingerprintHeaders(selection.account.fingerprint);

		return {
			accountIndex: selection.account.index,
			token: tokenResult.token,
			projectId: tokenResult.projectId,
			headers,
			headerStyle: selection.headerStyle,
			switched: selection.switched,
		};
	}

	// ========================================================================
	// VERIFICATION
	// ========================================================================

	/**
	 * Mark an account as requiring verification. Disables it and sets a 10-minute cooldown.
	 */
	markVerificationRequired(accountIndex: number, reason?: string, verifyUrl?: string): void {
		const account = this.accounts[accountIndex];
		if (!account) return;

		account.verificationRequired = true;
		account.verificationRequiredAt = Date.now();
		account.verificationReason = reason;
		account.verificationUrl = verifyUrl;
		account.enabled = false;
		account.coolingDownUntil = Date.now() + 10 * 60 * 1000; // 10 min
		account.cooldownReason = "validation-required";

		// If this was the active account for any family, find a replacement
		for (const family of ["claude", "gemini"] as ModelFamily[]) {
			if (this.activeIndexByFamily[family] === accountIndex) {
				const next = this.accounts.find((a) => a.index !== accountIndex && a.enabled);
				this.activeIndexByFamily[family] = next?.index ?? -1;
			}
		}

		this.requestSave();
	}

	/**
	 * Clear verification requirement and optionally re-enable the account.
	 */
	clearVerification(accountIndex: number, enableAccount = false): void {
		const account = this.accounts[accountIndex];
		if (!account) return;

		account.verificationRequired = false;
		account.verificationRequiredAt = undefined;
		account.verificationReason = undefined;
		account.verificationUrl = undefined;

		if (enableAccount) {
			account.enabled = true;
			delete account.coolingDownUntil;
			delete account.cooldownReason;
		}

		this.requestSave();
	}

	// ========================================================================
	// FINGERPRINT MANAGEMENT
	// ========================================================================

	/**
	 * Regenerate fingerprint for an account, saving the old one to history.
	 * Returns the new fingerprint, or null if account not found.
	 */
	regenerateFingerprint(accountIndex: number): DeviceFingerprint | null {
		const account = this.accounts[accountIndex];
		if (!account) return null;

		// Save current fingerprint to history
		if (account.fingerprint) {
			const historyEntry: FingerprintVersion = {
				fingerprint: { ...account.fingerprint },
				timestamp: Date.now(),
				reason: "regenerated",
			};

			if (!account.fingerprintHistory) {
				account.fingerprintHistory = [];
			}

			account.fingerprintHistory.unshift(historyEntry);

			// Trim to max history size
			if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
				account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY);
			}
		}

		// Generate new fingerprint
		account.fingerprint = generateFingerprint();
		this.requestSave();

		return account.fingerprint;
	}

	/**
	 * Get fingerprint history for an account.
	 */
	getFingerprintHistory(accountIndex: number): FingerprintVersion[] {
		const account = this.accounts[accountIndex];
		if (!account || !account.fingerprintHistory) {
			return [];
		}
		return [...account.fingerprintHistory];
	}

	// ========================================================================
	// INTERNAL HELPERS
	// ========================================================================

	private getHealthScore(account: PoolAccount): number {
		const hoursSinceUpdate = account.lastFailureTime ? (Date.now() - account.lastFailureTime) / (1000 * 60 * 60) : 0;
		const recovered = Math.floor(hoursSinceUpdate * HEALTH_RECOVERY_PER_HOUR);
		return Math.min(HEALTH_MAX, account.healthScore + recovered);
	}

	private isAccountCoolingDown(account: PoolAccount): boolean {
		if (account.coolingDownUntil === undefined) return false;
		if (Date.now() >= account.coolingDownUntil) {
			delete account.coolingDownUntil;
			delete account.cooldownReason;
			return false;
		}
		return true;
	}

	private hydrateAccount(stored: StoredAccount, index: number): PoolAccount {
		return {
			index,
			email: stored.email,
			refreshToken: stored.refreshToken,
			projectId: stored.projectId,
			addedAt: stored.addedAt ?? Date.now(),
			lastUsed: stored.lastUsed ?? 0,
			enabled: stored.enabled !== false,
			rateLimitResetTimes: stored.rateLimitResetTimes ?? {},
			lastSwitchReason: stored.lastSwitchReason,
			coolingDownUntil: stored.coolingDownUntil,
			cooldownReason: stored.cooldownReason,
			consecutiveFailures: stored.consecutiveFailures ?? 0,
			fingerprint: stored.fingerprint ?? generateFingerprint(),
			fingerprintHistory: stored.fingerprintHistory,
			healthScore: stored.healthScore ?? HEALTH_INITIAL,
			verificationRequired: stored.verificationRequired,
			verificationRequiredAt: stored.verificationRequiredAt,
			verificationReason: stored.verificationReason,
			verificationUrl: stored.verificationUrl,
		};
	}

	private dehydrateAccount(account: PoolAccount): StoredAccount {
		clearExpiredRateLimits(account.rateLimitResetTimes);
		return {
			email: account.email,
			refreshToken: account.refreshToken,
			projectId: account.projectId,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			enabled: account.enabled,
			rateLimitResetTimes:
				Object.keys(account.rateLimitResetTimes).length > 0 ? account.rateLimitResetTimes : undefined,
			lastSwitchReason: account.lastSwitchReason,
			coolingDownUntil: account.coolingDownUntil,
			cooldownReason: account.cooldownReason,
			fingerprint: account.fingerprint,
			fingerprintHistory: account.fingerprintHistory?.length ? account.fingerprintHistory : undefined,
			healthScore: account.healthScore,
			consecutiveFailures: account.consecutiveFailures > 0 ? account.consecutiveFailures : undefined,
			verificationRequired: account.verificationRequired,
			verificationRequiredAt: account.verificationRequiredAt,
			verificationReason: account.verificationReason,
			verificationUrl: account.verificationUrl,
		};
	}

	// ========================================================================
	// TESTING HELPERS
	// ========================================================================

	/** Get raw accounts (for testing) */
	_getAccounts(): PoolAccount[] {
		return [...this.accounts];
	}

	/** Get active index for a family (for testing) */
	_getActiveIndex(family: ModelFamily): number {
		return this.activeIndexByFamily[family];
	}
}
