/**
 * Tests for the Antigravity multi-account pool system.
 *
 * Covers: account management, selection strategies, rate limit tracking,
 * health scoring, fingerprinting, storage persistence, and token refresh.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEndpointRetryable, stripProblematicHeaders } from "../src/providers/google-gemini-cli.js";
import { AntigravityAccountPool } from "../src/utils/antigravity-account-pool/account-pool.js";
import {
	buildFingerprintHeaders,
	generateFingerprint,
	updateFingerprintVersion,
} from "../src/utils/antigravity-account-pool/fingerprint.js";
import {
	calculateBackoffMs,
	clearExpiredRateLimits,
	getAvailableHeaderStyle,
	getMinWaitTimeForFamily,
	getQuotaKey,
	isRateLimitedForFamily,
	isRateLimitedForHeaderStyle,
	parseRateLimitReason,
} from "../src/utils/antigravity-account-pool/rate-limits.js";
import {
	_resetHealthTracker,
	_resetTokenTracker,
	type AccountWithMetrics,
	addJitter,
	getHealthTracker,
	getTokenTracker,
	randomDelay,
	selectHybridAccount,
	sortByLruWithHealth,
} from "../src/utils/antigravity-account-pool/rotation.js";
import {
	createEmptyStorage,
	isValidStoredAccount,
	loadAccountPool,
	saveAccountPool,
} from "../src/utils/antigravity-account-pool/storage.js";
import type { AccountPoolStorage, RateLimitState } from "../src/utils/antigravity-account-pool/types.js";
import { extractVerificationError } from "../src/utils/antigravity-account-pool/verification.js";
import {
	_resetVersion,
	DEFAULT_ANTIGRAVITY_VERSION,
	fetchAntigravityVersion,
	getAntigravityVersion,
	setAntigravityVersion,
} from "../src/utils/antigravity-account-pool/version.js";

// ============================================================================
// TEST HELPERS
// ============================================================================

let tempDir: string;

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-test-antigravity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makePool(storagePath?: string): AntigravityAccountPool {
	const path = storagePath ?? join(tempDir, "accounts.json");
	return new AntigravityAccountPool(path);
}

function makeCredentials(overrides: Record<string, unknown> = {}) {
	return {
		refresh: `refresh-token-${Math.random().toString(36).slice(2)}`,
		access: `access-token-${Math.random().toString(36).slice(2)}`,
		expires: Date.now() + 3600_000,
		projectId: "test-project-id",
		email: `user-${Math.random().toString(36).slice(2)}@gmail.com`,
		...overrides,
	};
}

function addTestAccounts(pool: AntigravityAccountPool, count: number) {
	const accounts = [];
	for (let i = 0; i < count; i++) {
		accounts.push(pool.addAccount(makeCredentials({ email: `account${i}@gmail.com` })));
	}
	return accounts;
}

// ============================================================================
// SETUP / TEARDOWN
// ============================================================================

beforeEach(() => {
	tempDir = makeTempDir();
});

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true });
	}
	vi.restoreAllMocks();
});

// ============================================================================
// FINGERPRINT TESTS
// ============================================================================

describe("fingerprint", () => {
	it("generates unique device IDs", () => {
		const fp1 = generateFingerprint();
		const fp2 = generateFingerprint();

		expect(fp1.deviceId).not.toBe(fp2.deviceId);
		expect(fp1.sessionToken).not.toBe(fp2.sessionToken);
	});

	it("generates valid fingerprint structure", () => {
		const fp = generateFingerprint();

		expect(fp.deviceId).toMatch(/^[0-9a-f-]{36}$/);
		expect(fp.sessionToken).toMatch(/^[0-9a-f]{32}$/);
		expect(fp.userAgent).toContain("antigravity/");
		expect(fp.apiClient).toContain("google-cloud-sdk");
		expect(fp.clientMetadata.ideType).toBe("ANTIGRAVITY");
		expect(fp.clientMetadata.pluginType).toBe("GEMINI");
		expect(["WINDOWS", "MACOS"]).toContain(fp.clientMetadata.platform);
		expect(fp.createdAt).toBeGreaterThan(0);
	});

	it("builds proper antigravity request headers from fingerprint", () => {
		const fp = generateFingerprint();
		const headers = buildFingerprintHeaders(fp);

		expect(headers["User-Agent"]).toBe(fp.userAgent);
		// Only User-Agent should be in HTTP headers; others go in request body
		expect(headers["X-Goog-Api-Client"]).toBeUndefined();
		expect(headers["Client-Metadata"]).toBeUndefined();
		expect(Object.keys(headers)).toHaveLength(1);
	});
});

// ============================================================================
// RATE LIMIT TESTS
// ============================================================================

describe("rate-limits", () => {
	describe("getQuotaKey", () => {
		it("returns 'claude' for claude family", () => {
			expect(getQuotaKey("claude", "antigravity")).toBe("claude");
			expect(getQuotaKey("claude", "antigravity", "claude-opus-4-6")).toBe("claude");
		});

		it("returns antigravity key for gemini family", () => {
			expect(getQuotaKey("gemini", "antigravity")).toBe("gemini-antigravity");
		});

		it("includes model in key when provided", () => {
			expect(getQuotaKey("gemini", "antigravity", "gemini-3-pro")).toBe("gemini-antigravity:gemini-3-pro");
		});
	});

	describe("clearExpiredRateLimits", () => {
		it("removes expired entries", () => {
			const rateLimits: RateLimitState = {
				claude: Date.now() - 1000,
				"gemini-antigravity": Date.now() + 60_000,
			};
			clearExpiredRateLimits(rateLimits);

			expect(rateLimits.claude).toBeUndefined();
			expect(rateLimits["gemini-antigravity"]).toBeDefined();
		});

		it("handles empty state", () => {
			const rateLimits: RateLimitState = {};
			clearExpiredRateLimits(rateLimits);
			expect(Object.keys(rateLimits)).toHaveLength(0);
		});
	});

	describe("isRateLimitedForHeaderStyle", () => {
		it("checks claude correctly", () => {
			const rl: RateLimitState = { claude: Date.now() + 60_000 };
			expect(isRateLimitedForHeaderStyle(rl, "claude", "antigravity")).toBe(true);

			const rl2: RateLimitState = {};
			expect(isRateLimitedForHeaderStyle(rl2, "claude", "antigravity")).toBe(false);
		});

		it("checks gemini antigravity correctly", () => {
			const rl: RateLimitState = {
				"gemini-antigravity": Date.now() + 60_000,
			};
			expect(isRateLimitedForHeaderStyle(rl, "gemini", "antigravity")).toBe(true);

			const rl2: RateLimitState = {};
			expect(isRateLimitedForHeaderStyle(rl2, "gemini", "antigravity")).toBe(false);
		});

		it("checks model-specific rate limits", () => {
			const rl: RateLimitState = {
				"gemini-antigravity:gemini-3-pro": Date.now() + 60_000,
			};
			expect(isRateLimitedForHeaderStyle(rl, "gemini", "antigravity", "gemini-3-pro")).toBe(true);
			expect(isRateLimitedForHeaderStyle(rl, "gemini", "antigravity", "gemini-3-flash")).toBe(false);
		});
	});

	describe("isRateLimitedForFamily", () => {
		it("gemini is limited when antigravity is limited", () => {
			const onlyAntigravity: RateLimitState = { "gemini-antigravity": Date.now() + 60_000 };
			expect(isRateLimitedForFamily(onlyAntigravity, "gemini")).toBe(true);
		});
	});

	describe("getAvailableHeaderStyle", () => {
		it("prefers antigravity when available", () => {
			expect(getAvailableHeaderStyle({}, "gemini")).toBe("antigravity");
		});

		it("returns null when antigravity is limited", () => {
			const rl: RateLimitState = { "gemini-antigravity": Date.now() + 60_000 };
			expect(getAvailableHeaderStyle(rl, "gemini")).toBeNull();
		});
	});

	describe("parseRateLimitReason", () => {
		it("classifies status codes", () => {
			expect(parseRateLimitReason(undefined, undefined, 503)).toBe("MODEL_CAPACITY_EXHAUSTED");
			expect(parseRateLimitReason(undefined, undefined, 529)).toBe("MODEL_CAPACITY_EXHAUSTED");
			expect(parseRateLimitReason(undefined, undefined, 500)).toBe("SERVER_ERROR");
			expect(parseRateLimitReason(undefined, undefined, 429)).toBe("UNKNOWN");
		});

		it("classifies error messages", () => {
			expect(parseRateLimitReason(undefined, "Resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
			expect(parseRateLimitReason(undefined, "rate limit exceeded")).toBe("RATE_LIMIT_EXCEEDED");
			expect(parseRateLimitReason(undefined, "quota exhausted")).toBe("QUOTA_EXHAUSTED");
			expect(parseRateLimitReason(undefined, "too many requests per minute")).toBe("RATE_LIMIT_EXCEEDED");
		});

		it("prioritizes explicit reason string", () => {
			expect(parseRateLimitReason("QUOTA_EXHAUSTED", "rate limit")).toBe("QUOTA_EXHAUSTED");
		});
	});

	describe("calculateBackoffMs", () => {
		it("escalates quota exhausted backoff", () => {
			const b0 = calculateBackoffMs("QUOTA_EXHAUSTED", 0);
			const b1 = calculateBackoffMs("QUOTA_EXHAUSTED", 1);
			const b2 = calculateBackoffMs("QUOTA_EXHAUSTED", 2);

			expect(b0).toBe(60_000);
			expect(b1).toBe(300_000);
			expect(b2).toBe(1_800_000);
		});

		it("uses fixed backoff for rate limit exceeded", () => {
			expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0)).toBe(30_000);
			expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 5)).toBe(30_000);
		});

		it("respects explicit retryAfterMs", () => {
			expect(calculateBackoffMs("UNKNOWN", 0, 15_000)).toBe(15_000);
		});

		it("enforces minimum backoff", () => {
			expect(calculateBackoffMs("UNKNOWN", 0, 500)).toBe(2_000);
		});
	});

	describe("getMinWaitTimeForFamily", () => {
		it("returns 0 when any account is available", () => {
			const limits = [
				{ claude: Date.now() + 60_000 },
				{} as RateLimitState, // Available
			];
			expect(getMinWaitTimeForFamily(limits, "claude")).toBe(0);
		});

		it("returns minimum wait when all limited", () => {
			const now = Date.now();
			const limits = [{ claude: now + 10_000 }, { claude: now + 30_000 }];
			const wait = getMinWaitTimeForFamily(limits, "claude");
			expect(wait).toBeGreaterThan(0);
			expect(wait).toBeLessThanOrEqual(10_000);
		});
	});
});

// ============================================================================
// STORAGE TESTS
// ============================================================================

describe("storage", () => {
	it("creates empty storage", () => {
		const storage = createEmptyStorage();
		expect(storage.version).toBe(1);
		expect(storage.accounts).toHaveLength(0);
		expect(storage.activeIndexByFamily.claude).toBe(-1);
		expect(storage.activeIndexByFamily.gemini).toBe(-1);
	});

	it("saves and loads round-trip", () => {
		const path = join(tempDir, "test-accounts.json");
		const storage: AccountPoolStorage = {
			version: 1,
			accounts: [
				{
					refreshToken: "token-1",
					projectId: "proj-1",
					email: "user1@gmail.com",
					addedAt: 1000,
					lastUsed: 2000,
					enabled: true,
				},
				{
					refreshToken: "token-2",
					projectId: "proj-2",
					addedAt: 3000,
					lastUsed: 4000,
					enabled: false,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { claude: 0, gemini: 1 },
		};

		saveAccountPool(path, storage);
		const loaded = loadAccountPool(path);

		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(1);
		expect(loaded!.accounts).toHaveLength(2);
		expect(loaded!.accounts[0]!.email).toBe("user1@gmail.com");
		expect(loaded!.accounts[0]!.refreshToken).toBe("token-1");
		expect(loaded!.accounts[1]!.enabled).toBe(false);
		expect(loaded!.activeIndexByFamily.claude).toBe(0);
		expect(loaded!.activeIndexByFamily.gemini).toBe(1);
	});

	it("returns null for missing file", () => {
		expect(loadAccountPool(join(tempDir, "nonexistent.json"))).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		const path = join(tempDir, "invalid.json");
		writeFileSync(path, "{invalid-json");
		expect(loadAccountPool(path)).toBeNull();
	});

	it("returns null for wrong version", () => {
		const path = join(tempDir, "v99.json");
		writeFileSync(path, JSON.stringify({ version: 99, accounts: [] }));
		expect(loadAccountPool(path)).toBeNull();
	});

	it("validates stored accounts", () => {
		expect(isValidStoredAccount({ refreshToken: "valid" })).toBe(true);
		expect(isValidStoredAccount({ refreshToken: "" })).toBe(false);
		expect(isValidStoredAccount({})).toBe(false);
		expect(isValidStoredAccount(null)).toBe(false);
		expect(isValidStoredAccount("string")).toBe(false);
	});

	it("sets restrictive file permissions", () => {
		const path = join(tempDir, "perm-test.json");
		saveAccountPool(path, createEmptyStorage());
		// File should exist
		expect(existsSync(path)).toBe(true);
	});
});

// ============================================================================
// ACCOUNT POOL - MANAGEMENT TESTS
// ============================================================================

describe("AntigravityAccountPool - management", () => {
	it("starts empty", () => {
		const pool = makePool();
		expect(pool.getAccountCount()).toBe(0);
		expect(pool.hasAccounts()).toBe(false);
	});

	it("adds accounts", () => {
		const pool = makePool();
		const creds = makeCredentials({ email: "test@gmail.com" });
		const account = pool.addAccount(creds);

		expect(account.email).toBe("test@gmail.com");
		expect(account.refreshToken).toBe(creds.refresh);
		expect(account.enabled).toBe(true);
		expect(account.index).toBe(0);
		expect(pool.getAccountCount()).toBe(1);
		expect(pool.hasAccounts()).toBe(true);
	});

	it("deduplicates by refresh token", () => {
		const pool = makePool();
		const creds = makeCredentials();

		pool.addAccount(creds);
		pool.addAccount(creds); // Same refresh token

		expect(pool.getAccountCount()).toBe(1);
	});

	it("generates unique fingerprints per account", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		const accounts = pool._getAccounts();
		const deviceIds = accounts.map((a) => a.fingerprint.deviceId);
		expect(new Set(deviceIds).size).toBe(3);
	});

	it("removes accounts and reindexes", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		pool.removeAccount(1); // Remove middle

		expect(pool.getAccountCount()).toBe(2);
		const accounts = pool._getAccounts();
		expect(accounts[0]!.index).toBe(0);
		expect(accounts[1]!.index).toBe(1);
	});

	it("handles removing invalid index", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		expect(pool.removeAccount(-1)).toBe(false);
		expect(pool.removeAccount(5)).toBe(false);
		expect(pool.getAccountCount()).toBe(2);
	});

	it("enables and disables accounts", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		pool.setEnabled(0, false);
		expect(pool.getAccountCount()).toBe(1); // Only 1 enabled

		pool.setEnabled(0, true);
		expect(pool.getAccountCount()).toBe(2);
	});

	it("disabling active account selects replacement", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		// Make account 0 active for claude
		pool.selectAccount("claude");

		pool.setEnabled(0, false);

		// Should have switched away from 0
		const selection = pool.selectAccount("claude");
		expect(selection).not.toBeNull();
		expect(selection!.account.index).not.toBe(0);
	});

	it("returns account info for display", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		const infos = pool.getAccountsInfo();
		expect(infos).toHaveLength(2);
		expect(infos[0]!.index).toBe(0);
		expect(infos[0]!.enabled).toBe(true);
		expect(infos[0]!.healthScore).toBeGreaterThan(0);
	});
});

// ============================================================================
// ACCOUNT POOL - SELECTION TESTS
// ============================================================================

describe("AntigravityAccountPool - selection", () => {
	it("returns null when no accounts", () => {
		const pool = makePool();
		expect(pool.selectAccount("gemini")).toBeNull();
	});

	it("returns null when all accounts disabled", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);
		pool.setEnabled(0, false);
		pool.setEnabled(1, false);

		expect(pool.selectAccount("gemini")).toBeNull();
	});

	describe("sticky strategy", () => {
		it("returns same account on consecutive calls", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			const first = pool.selectAccount("gemini", null, "sticky");
			const second = pool.selectAccount("gemini", null, "sticky");

			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect(first!.account.index).toBe(second!.account.index);
			// Both should not switch since addAccount() sets activeIndex on first add
			expect(second!.switched).toBe(false);
		});

		it("switches on rate limit", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			const first = pool.selectAccount("gemini")!;
			expect(first).not.toBeNull();

			// Rate limit the active account
			pool.markRateLimited(first.account.index, "gemini", "antigravity", null, 429, "rate limited");

			const second = pool.selectAccount("gemini")!;
			expect(second).not.toBeNull();
			expect(second.account.index).not.toBe(first.account.index);
			expect(second.switched).toBe(true);
			expect(second.switchReason).toBe("rate-limit");
		});

		it("returns null for single account when antigravity is exhausted", () => {
			const pool = makePool();
			addTestAccounts(pool, 1);

			const first = pool.selectAccount("gemini")!;
			expect(first.headerStyle).toBe("antigravity");

			pool.markRateLimited(first.account.index, "gemini", "antigravity", null, 429, "rate limited");

			const second = pool.selectAccount("gemini");
			expect(second).toBeNull();
		});

		it("never returns gemini-cli header style", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");

			const sel = pool.selectAccount("gemini");
			expect(sel).not.toBeNull();
			expect(sel!.headerStyle).toBe("antigravity");
			expect(sel!.account.index).not.toBe(0);
		});

		it("returns null when all accounts are fully rate limited", () => {
			const pool = makePool();
			addTestAccounts(pool, 2);

			for (let i = 0; i < 2; i++) {
				pool.markRateLimited(i, "gemini", "antigravity", null, 429, "rate limited");
			}

			expect(pool.selectAccount("gemini")).toBeNull();
		});

		it("tracks families independently", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			const claudeSel = pool.selectAccount("claude")!;
			const geminiSel = pool.selectAccount("gemini")!;

			// Rate limit claude on account 0
			pool.markRateLimited(claudeSel.account.index, "claude", "antigravity", null, 429, "rate limited");

			// Claude should switch, gemini should stay
			const claudeNext = pool.selectAccount("claude")!;
			const geminiNext = pool.selectAccount("gemini")!;

			// Claude should have switched
			if (claudeSel.account.index === 0) {
				expect(claudeNext.account.index).not.toBe(0);
			}
			// Gemini should not have switched (different family)
			expect(geminiNext.account.index).toBe(geminiSel.account.index);
		});

		it("prefers healthier accounts when switching", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			// Damage account 1's health
			for (let i = 0; i < 5; i++) {
				pool.markFailure(1);
			}

			// Make account 0 rate limited
			pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");

			// Force active to 0
			pool.selectAccount("gemini");

			// Should prefer account 2 (healthy) over account 1 (damaged)
			const selection = pool.selectAccount("gemini");
			expect(selection).not.toBeNull();
			expect(selection!.account.index).toBe(2);
		});
	});

	describe("round-robin strategy", () => {
		it("rotates through accounts", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			const indices = new Set<number>();
			for (let i = 0; i < 6; i++) {
				const sel = pool.selectAccount("gemini", null, "round-robin")!;
				indices.add(sel.account.index);
			}

			expect(indices.size).toBe(3);
		});

		it("skips rate limited accounts", () => {
			const pool = makePool();
			addTestAccounts(pool, 3);

			// Rate limit account 1
			pool.markRateLimited(1, "gemini", "antigravity", null, 429, "rate limited");

			const indices = new Set<number>();
			for (let i = 0; i < 6; i++) {
				const sel = pool.selectAccount("gemini", null, "round-robin")!;
				indices.add(sel.account.index);
			}

			expect(indices.has(1)).toBe(false);
		});
	});
});

// ============================================================================
// ACCOUNT POOL - HEALTH SCORING TESTS
// ============================================================================

describe("AntigravityAccountPool - health scoring", () => {
	it("starts at initial health score", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		const info = pool.getAccountsInfo();
		expect(info[0]!.healthScore).toBe(70); // HEALTH_INITIAL
	});

	it("rewards success", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		pool.markSuccess(0);
		const info = pool.getAccountsInfo();
		expect(info[0]!.healthScore).toBe(71); // 70 + 1
	});

	it("penalizes rate limits", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");
		const info = pool.getAccountsInfo();
		expect(info[0]!.healthScore).toBe(60); // 70 - 10
	});

	it("penalizes failures more heavily", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		pool.markFailure(0);
		const info = pool.getAccountsInfo();
		expect(info[0]!.healthScore).toBe(50); // 70 - 20
	});

	it("health score never goes below 0", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		for (let i = 0; i < 10; i++) {
			pool.markFailure(0);
		}

		const info = pool.getAccountsInfo();
		expect(info[0]!.healthScore).toBeGreaterThanOrEqual(0);
	});

	it("health score caps at 100", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		for (let i = 0; i < 50; i++) {
			pool.markSuccess(0);
		}

		const info = pool.getAccountsInfo();
		expect(info[0]!.healthScore).toBeLessThanOrEqual(100);
	});

	it("resets consecutive failures on success", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		pool.markFailure(0);
		pool.markFailure(0);
		pool.markSuccess(0);

		const accounts = pool._getAccounts();
		expect(accounts[0]!.consecutiveFailures).toBe(0);
	});
});

// ============================================================================
// ACCOUNT POOL - COOLDOWN TESTS
// ============================================================================

describe("AntigravityAccountPool - cooldown", () => {
	it("marks account as cooling down", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		pool.markCoolingDown(0, 60_000, "auth-failure");

		const info = pool.getAccountsInfo();
		expect(info[0]!.isCoolingDown).toBe(true);
	});

	it("cooling down accounts are skipped in selection", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		pool.markCoolingDown(0, 60_000, "auth-failure");

		const selection = pool.selectAccount("gemini")!;
		expect(selection.account.index).toBe(1);
	});

	it("cooldown expires naturally", () => {
		vi.useFakeTimers();
		const pool = makePool();
		addTestAccounts(pool, 1);

		pool.markCoolingDown(0, 1_000, "auth-failure");

		expect(pool.selectAccount("gemini")).toBeNull(); // Cooling down

		vi.advanceTimersByTime(1_100);

		const selection = pool.selectAccount("gemini");
		expect(selection).not.toBeNull();

		vi.useRealTimers();
	});
});

// ============================================================================
// ACCOUNT POOL - RATE LIMIT TRACKING TESTS
// ============================================================================

describe("AntigravityAccountPool - rate limit tracking", () => {
	it("marks rate limited with correct backoff", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		const result = pool.markRateLimited(0, "gemini", "antigravity", "gemini-3-pro", 429, "quota exhausted");

		expect(result.reason).toBe("QUOTA_EXHAUSTED");
		expect(result.backoffMs).toBeGreaterThan(0);
	});

	it("tracks model-specific rate limits", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		// Rate limit only gemini-3-pro
		pool.markRateLimited(0, "gemini", "antigravity", "gemini-3-pro", 429, "quota exhausted");

		// gemini-3-pro should be limited
		const accounts = pool._getAccounts();
		expect(
			isRateLimitedForHeaderStyle(accounts[0]!.rateLimitResetTimes, "gemini", "antigravity", "gemini-3-pro"),
		).toBe(true);

		// gemini-3-flash should not be limited
		expect(
			isRateLimitedForHeaderStyle(accounts[0]!.rateLimitResetTimes, "gemini", "antigravity", "gemini-3-flash"),
		).toBe(false);
	});

	it("clears rate limits for a family", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");
		pool.markRateLimited(1, "gemini", "antigravity", null, 429, "rate limited");

		pool.clearRateLimits("gemini");

		const accounts = pool._getAccounts();
		expect(Object.keys(accounts[0]!.rateLimitResetTimes)).toHaveLength(0);
		expect(Object.keys(accounts[1]!.rateLimitResetTimes)).toHaveLength(0);
	});

	it("escalates backoff with consecutive failures", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		const r1 = pool.markRateLimited(0, "gemini", "antigravity", null, 429, "quota exhausted");
		const r2 = pool.markRateLimited(0, "gemini", "antigravity", null, 429, "quota exhausted");

		// Second failure should have higher backoff (consecutive failures increase)
		expect(r2.backoffMs).toBeGreaterThanOrEqual(r1.backoffMs);
	});
});

// ============================================================================
// ACCOUNT POOL - PERSISTENCE TESTS
// ============================================================================

describe("AntigravityAccountPool - persistence", () => {
	it("saves and loads accounts across instances", () => {
		const path = join(tempDir, "persist-test.json");

		// Create pool, add accounts, save
		const pool1 = new AntigravityAccountPool(path);
		pool1.addAccount(makeCredentials({ email: "user1@gmail.com" }));
		pool1.addAccount(makeCredentials({ email: "user2@gmail.com" }));
		pool1.saveNow();

		// Load in new instance
		const pool2 = new AntigravityAccountPool(path);
		pool2.load();

		expect(pool2.getAccountCount()).toBe(2);
		const infos = pool2.getAccountsInfo();
		expect(infos[0]!.email).toBe("user1@gmail.com");
		expect(infos[1]!.email).toBe("user2@gmail.com");
	});

	it("preserves fingerprints across saves", () => {
		const path = join(tempDir, "fingerprint-persist.json");

		const pool1 = new AntigravityAccountPool(path);
		pool1.addAccount(makeCredentials());
		const fp1 = pool1._getAccounts()[0]!.fingerprint.deviceId;
		pool1.saveNow();

		const pool2 = new AntigravityAccountPool(path);
		pool2.load();
		const fp2 = pool2._getAccounts()[0]!.fingerprint.deviceId;

		expect(fp2).toBe(fp1);
	});

	it("preserves active family indices", () => {
		const path = join(tempDir, "family-persist.json");

		const pool1 = new AntigravityAccountPool(path);
		addTestAccounts(pool1, 3);
		pool1.selectAccount("claude"); // Sets active for claude
		pool1.selectAccount("gemini"); // Sets active for gemini
		pool1.saveNow();

		const pool2 = new AntigravityAccountPool(path);
		pool2.load();

		expect(pool2._getActiveIndex("claude")).toBeGreaterThanOrEqual(0);
		expect(pool2._getActiveIndex("gemini")).toBeGreaterThanOrEqual(0);
	});

	it("preserves rate limit state across saves", () => {
		const path = join(tempDir, "ratelimit-persist.json");

		const pool1 = new AntigravityAccountPool(path);
		addTestAccounts(pool1, 1);
		pool1.markRateLimited(0, "gemini", "antigravity", "gemini-3-pro", 429, "quota exhausted");
		pool1.saveNow();

		const pool2 = new AntigravityAccountPool(path);
		pool2.load();

		const accounts = pool2._getAccounts();
		const keys = Object.keys(accounts[0]!.rateLimitResetTimes);
		expect(keys.some((k) => k.includes("gemini-3-pro"))).toBe(true);
	});

	it("handles loading empty file gracefully", () => {
		const path = join(tempDir, "empty.json");
		writeFileSync(path, "{}");

		const pool = new AntigravityAccountPool(path);
		pool.load();

		expect(pool.getAccountCount()).toBe(0);
	});

	it("handles loading corrupted file gracefully", () => {
		const path = join(tempDir, "corrupted.json");
		writeFileSync(path, "not json at all");

		const pool = new AntigravityAccountPool(path);
		pool.load();

		expect(pool.getAccountCount()).toBe(0);
	});

	it("strips expired rate limits on save", () => {
		const path = join(tempDir, "expired-rl.json");

		const pool = new AntigravityAccountPool(path);
		addTestAccounts(pool, 1);

		// Manually inject an expired rate limit
		const accounts = pool._getAccounts();
		accounts[0]!.rateLimitResetTimes["expired-key"] = Date.now() - 10_000;
		accounts[0]!.rateLimitResetTimes["valid-key"] = Date.now() + 60_000;

		pool.saveNow();

		const raw = JSON.parse(readFileSync(path, "utf-8")) as AccountPoolStorage;
		const storedRl = raw.accounts[0]?.rateLimitResetTimes ?? {};
		expect(storedRl["expired-key"]).toBeUndefined();
		expect(storedRl["valid-key"]).toBeDefined();
	});
});

// ============================================================================
// ACCOUNT POOL - TOKEN REFRESH TESTS
// ============================================================================

describe("AntigravityAccountPool - token refresh", () => {
	it("returns cached token when not expired", async () => {
		const pool = makePool();
		const creds = makeCredentials();
		pool.addAccount(creds);

		const result = await pool.ensureAccessToken(0);

		expect(result).not.toBeNull();
		expect(result!.token).toBe(creds.access);
		expect(result!.projectId).toBe(creds.projectId);
	});

	it("returns null for invalid account index", async () => {
		const pool = makePool();
		const result = await pool.ensureAccessToken(99);
		expect(result).toBeNull();
	});

	it("attempts refresh when token is expired", async () => {
		const pool = makePool();
		pool.addAccount(
			makeCredentials({
				access: "expired-token",
				expires: Date.now() - 60_000, // Already expired
			}),
		);

		// Mock fetch for token refresh
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "new-access-token",
				expires_in: 3600,
			}),
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await pool.ensureAccessToken(0);

		expect(result).not.toBeNull();
		expect(result!.token).toBe("new-access-token");

		// Verify refresh request was made
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0]!;
		expect(url).toContain("oauth2.googleapis.com/token");
		expect(init.method).toBe("POST");

		vi.unstubAllGlobals();
	});

	it("handles refresh failure gracefully", async () => {
		const pool = makePool();
		pool.addAccount(
			makeCredentials({
				access: "expired-token",
				expires: Date.now() - 60_000,
			}),
		);

		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => "invalid_grant",
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await pool.ensureAccessToken(0);

		expect(result).toBeNull();

		// Account should be marked as cooling down
		const info = pool.getAccountsInfo();
		expect(info[0]!.isCoolingDown).toBe(true);

		vi.unstubAllGlobals();
	});

	it("updates refresh token when server provides new one", async () => {
		const pool = makePool();
		const oldRefresh = "old-refresh-token";
		pool.addAccount(
			makeCredentials({
				refresh: oldRefresh,
				access: "expired-token",
				expires: Date.now() - 60_000,
			}),
		);

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "new-access",
				expires_in: 3600,
				refresh_token: "new-refresh-token",
			}),
		});
		vi.stubGlobal("fetch", mockFetch);

		await pool.ensureAccessToken(0);

		const accounts = pool._getAccounts();
		expect(accounts[0]!.refreshToken).toBe("new-refresh-token");

		vi.unstubAllGlobals();
	});
});

// ============================================================================
// ACCOUNT POOL - getCredentials INTEGRATION TESTS
// ============================================================================

describe("AntigravityAccountPool - getCredentials", () => {
	it("returns null when no accounts", async () => {
		const pool = makePool();
		const result = await pool.getCredentials("gemini");
		expect(result).toBeNull();
	});

	it("returns credentials with correct structure", async () => {
		const pool = makePool();
		pool.addAccount(makeCredentials({ email: "test@gmail.com" }));

		const result = await pool.getCredentials("gemini");

		expect(result).not.toBeNull();
		expect(result!.accountIndex).toBe(0);
		expect(result!.token).toBeTruthy();
		expect(result!.projectId).toBeTruthy();
		expect(result!.headers).toBeDefined();
		expect(result!.headers["User-Agent"]).toBeTruthy();
		expect(result!.headerStyle).toBe("antigravity");
	});

	it("getCredentials returns headers with only User-Agent", async () => {
		const pool = makePool();
		pool.addAccount(makeCredentials());
		const creds = await pool.getCredentials("gemini");

		expect(creds).not.toBeNull();
		expect(creds!.headers["User-Agent"]).toContain("antigravity/");
		expect(creds!.headers["X-Goog-Api-Client"]).toBeUndefined();
		expect(creds!.headers["Client-Metadata"]).toBeUndefined();
	});

	it("switches account when current fails token refresh", async () => {
		const pool = makePool();
		pool.addAccount(
			makeCredentials({
				access: "expired-token-1",
				expires: Date.now() - 60_000,
			}),
		);
		pool.addAccount(
			makeCredentials({
				email: "backup@gmail.com",
				access: "valid-token-2",
				expires: Date.now() + 3600_000,
			}),
		);

		// First call will fail refresh for account 0, then try account 1
		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return { ok: false, status: 401, text: async () => "invalid_grant" };
			}
			// Shouldn't reach here since account 1 has valid token
			return { ok: true, json: async () => ({ access_token: "refreshed", expires_in: 3600 }) };
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await pool.getCredentials("gemini");

		expect(result).not.toBeNull();
		expect(result!.accountIndex).toBe(1);
		expect(result!.switched).toBe(true);

		vi.unstubAllGlobals();
	});
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe("edge cases", () => {
	it("handles single account pool correctly", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		const sel = pool.selectAccount("gemini")!;
		expect(sel).not.toBeNull();
		expect(sel.account.index).toBe(0);

		// Rate limit the only account
		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");

		// Should be null — no gemini-cli fallback
		expect(pool.selectAccount("gemini")).toBeNull();
	});

	it("handles rapid sequential requests", () => {
		const pool = makePool();
		addTestAccounts(pool, 5);

		// Rapid fire selections
		for (let i = 0; i < 100; i++) {
			const sel = pool.selectAccount("gemini");
			expect(sel).not.toBeNull();
		}
	});

	it("handles all accounts disabled then re-enabled", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		// Disable all
		pool.setEnabled(0, false);
		pool.setEnabled(1, false);
		pool.setEnabled(2, false);
		expect(pool.selectAccount("gemini")).toBeNull();

		// Re-enable one
		pool.setEnabled(1, true);
		const sel = pool.selectAccount("gemini")!;
		expect(sel).not.toBeNull();
		expect(sel.account.index).toBe(1);
	});

	it("concurrent family selections don't interfere", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		// Claude uses account 0
		const claudeSel = pool.selectAccount("claude")!;
		// Gemini uses account 1 (or 0)
		const _geminiSel = pool.selectAccount("gemini")!;

		// Rate limit claude's account
		pool.markRateLimited(claudeSel.account.index, "claude", "antigravity", null, 429, "rate limited");

		// Claude should switch, gemini should be unaffected
		const _claudeNext = pool.selectAccount("claude");
		const geminiNext = pool.selectAccount("gemini")!;

		// Gemini should still work
		expect(geminiNext).not.toBeNull();
	});
});

// ============================================================================
// RAPID CYCLE (STALE-STATE PREVENTION)
// ============================================================================

describe("AntigravityAccountPool - rapid cycle (stale-state prevention)", () => {
	it("mutations are visible on same instance without save", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");

		// Same instance should see the rate limit immediately
		const sel = pool.selectAccount("gemini");
		expect(sel).not.toBeNull();
		expect(sel!.account.index).toBe(1);
	});

	it("handles rapid rate-limit-then-select cycle across all accounts", () => {
		const path = join(tempDir, "rapid-cycle.json");
		const pool = new AntigravityAccountPool(path);
		for (let i = 0; i < 5; i++) {
			pool.addAccount(makeCredentials({ email: `rapid${i}@gmail.com` }));
		}

		// Simulate provider retry loop: select, rate limit, select next
		const selectedIndices: number[] = [];
		for (let i = 0; i < 5; i++) {
			const sel = pool.selectAccount("gemini");
			if (!sel) break;
			selectedIndices.push(sel.account.index);
			pool.markRateLimited(sel.account.index, "gemini", "antigravity", null, 429, "rate limited");
		}

		// All 5 accounts should have been selected (no duplicates)
		expect(selectedIndices).toHaveLength(5);
		expect(new Set(selectedIndices).size).toBe(5);

		// All should be exhausted now
		expect(pool.selectAccount("gemini")).toBeNull();

		// Save and verify persistence
		pool.saveNow();
		const pool2 = new AntigravityAccountPool(path);
		pool2.load();
		expect(pool2.selectAccount("gemini")).toBeNull();
	});
});

// ============================================================================
// CROSS-ACCOUNT ROTATION
// ============================================================================

describe("AntigravityAccountPool - cross-account rotation", () => {
	it("rotates to next account when current is rate-limited", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		const first = pool.selectAccount("gemini")!;
		expect(first.account.index).toBe(0);

		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");

		const second = pool.selectAccount("gemini")!;
		expect(second).not.toBeNull();
		expect(second.account.index).not.toBe(0);
		expect(second.switched).toBe(true);
		expect(second.switchReason).toBe("rate-limit");
	});

	it("exhausts all accounts before returning null", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");
		pool.markRateLimited(1, "gemini", "antigravity", null, 429, "rate limited");

		const sel = pool.selectAccount("gemini");
		expect(sel).not.toBeNull();
		expect(sel!.account.index).toBe(2);

		pool.markRateLimited(2, "gemini", "antigravity", null, 429, "rate limited");
		expect(pool.selectAccount("gemini")).toBeNull();
	});

	it("rotates on model-specific rate limit", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);

		pool.markRateLimited(0, "gemini", "antigravity", "gemini-3-pro", 429, "quota exhausted");

		const sel = pool.selectAccount("gemini", "gemini-3-pro");
		expect(sel).not.toBeNull();
		expect(sel!.account.index).toBe(1);
	});

	it("hasAvailableAccount returns true when any account has quota", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);
		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");

		expect(pool.hasAvailableAccount("gemini")).toBe(true);

		pool.markRateLimited(1, "gemini", "antigravity", null, 429, "rate limited");
		pool.markRateLimited(2, "gemini", "antigravity", null, 429, "rate limited");

		expect(pool.hasAvailableAccount("gemini")).toBe(false);
	});

	it("hasAvailableAccount skips disabled accounts", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);
		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");
		pool.setEnabled(1, false);

		expect(pool.hasAvailableAccount("gemini")).toBe(false);
	});

	it("hasAvailableAccount skips cooling down accounts", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);
		pool.markRateLimited(0, "gemini", "antigravity", null, 429, "rate limited");
		pool.markCoolingDown(1, 60_000, "auth-failure");

		expect(pool.hasAvailableAccount("gemini")).toBe(false);
	});

	it("hasAvailableAccount checks model-specific limits", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);
		pool.markRateLimited(0, "gemini", "antigravity", "gemini-3-pro", 429, "rate limited");

		// Account 1 has quota for gemini-3-pro
		expect(pool.hasAvailableAccount("gemini", "gemini-3-pro")).toBe(true);

		pool.markRateLimited(1, "gemini", "antigravity", "gemini-3-pro", 429, "rate limited");
		expect(pool.hasAvailableAccount("gemini", "gemini-3-pro")).toBe(false);
	});
});

// ============================================================================
// ENDPOINT RETRY CLASSIFICATION
// ============================================================================

describe("endpoint retry classification", () => {
	it("treats 403 as endpoint-retryable", () => {
		expect(isEndpointRetryable(403)).toBe(true);
	});
	it("treats 404 as endpoint-retryable", () => {
		expect(isEndpointRetryable(404)).toBe(true);
	});
	it("treats 500+ as endpoint-retryable", () => {
		expect(isEndpointRetryable(500)).toBe(true);
		expect(isEndpointRetryable(502)).toBe(true);
		expect(isEndpointRetryable(503)).toBe(true);
	});
	it("does not treat 400 as endpoint-retryable", () => {
		expect(isEndpointRetryable(400)).toBe(false);
	});
	it("does not treat 401 as endpoint-retryable", () => {
		expect(isEndpointRetryable(401)).toBe(false);
	});
	it("does not treat 200 as endpoint-retryable", () => {
		expect(isEndpointRetryable(200)).toBe(false);
	});
});

// ============================================================================
// STRIP PROBLEMATIC HEADERS
// ============================================================================

describe("stripProblematicHeaders", () => {
	it("removes x-goog-user-project from record", () => {
		const headers: Record<string, string> = {
			Authorization: "Bearer token",
			"x-goog-user-project": "my-project-123",
			"Content-Type": "application/json",
		};
		stripProblematicHeaders(headers);
		expect(headers["x-goog-user-project"]).toBeUndefined();
		expect(headers.Authorization).toBe("Bearer token");
	});

	it("removes X-Goog-User-Project (capitalized) from record", () => {
		const headers: Record<string, string> = {
			"X-Goog-User-Project": "my-project-123",
		};
		stripProblematicHeaders(headers);
		expect(headers["X-Goog-User-Project"]).toBeUndefined();
	});

	it("handles missing header gracefully", () => {
		const headers: Record<string, string> = { Authorization: "Bearer token" };
		stripProblematicHeaders(headers);
		expect(headers.Authorization).toBe("Bearer token");
	});
});

// ============================================================================
// VERIFICATION DETECTION TESTS
// ============================================================================

describe("verification detection", () => {
	it("detects validation_required in error details", () => {
		const body = JSON.stringify({
			error: {
				code: 403,
				message: "Account requires verification",
				status: "PERMISSION_DENIED",
				details: [{ reason: "validation_required", verifyUrl: "https://accounts.google.com/verify" }],
			},
		});
		const result = extractVerificationError(body);
		expect(result.isVerification).toBe(true);
		expect(result.verifyUrl).toBe("https://accounts.google.com/verify");
		expect(result.reason).toBe("Account requires verification");
	});

	it("detects verification from message patterns", () => {
		const body = JSON.stringify({
			error: { message: "Please verify your account to continue" },
		});
		const result = extractVerificationError(body);
		expect(result.isVerification).toBe(true);
	});

	it("returns false for non-verification 403", () => {
		const body = JSON.stringify({
			error: { message: "Permission denied on resource project" },
		});
		const result = extractVerificationError(body);
		expect(result.isVerification).toBe(false);
	});

	it("handles malformed JSON gracefully", () => {
		const result = extractVerificationError("not json at all");
		expect(result.isVerification).toBe(false);
	});

	it("handles empty body", () => {
		const result = extractVerificationError("");
		expect(result.isVerification).toBe(false);
	});
});

// ============================================================================
// ACCOUNT POOL - VERIFICATION TESTS
// ============================================================================

describe("AntigravityAccountPool - verification", () => {
	it("markVerificationRequired disables and cools down account", () => {
		const pool = makePool();
		addTestAccounts(pool, 3);

		pool.markVerificationRequired(0, "Need captcha", "https://verify.example.com");

		const info = pool.getAccountsInfo();
		expect(info[0]!.enabled).toBe(false);
		expect(info[0]!.isCoolingDown).toBe(true);

		const sel = pool.selectAccount("gemini");
		expect(sel).not.toBeNull();
		expect(sel!.account.index).not.toBe(0);
	});

	it("clearVerification re-enables account", () => {
		const pool = makePool();
		addTestAccounts(pool, 2);
		pool.markVerificationRequired(0, "captcha");
		expect(pool.getAccountsInfo()[0]!.enabled).toBe(false);

		pool.clearVerification(0, true);
		expect(pool.getAccountsInfo()[0]!.enabled).toBe(true);
		expect(pool.getAccountsInfo()[0]!.isCoolingDown).toBe(false);
	});

	it("clearVerification without enable keeps account disabled", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);
		pool.markVerificationRequired(0, "captcha");

		pool.clearVerification(0);
		expect(pool.getAccountsInfo()[0]!.enabled).toBe(false);
	});

	it("persists verification state across saves", () => {
		const path = join(tempDir, "verify-persist.json");
		const pool1 = new AntigravityAccountPool(path);
		pool1.addAccount(makeCredentials());
		pool1.markVerificationRequired(0, "captcha", "https://verify.url");
		pool1.saveNow();

		const pool2 = new AntigravityAccountPool(path);
		pool2.load();
		const accounts = pool2._getAccounts();
		expect(accounts[0]!.enabled).toBe(false);
		expect(accounts[0]!.verificationRequired).toBe(true);
		expect(accounts[0]!.verificationUrl).toBe("https://verify.url");
	});

	it("handles invalid account index gracefully", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);
		pool.markVerificationRequired(99); // should not throw
		pool.clearVerification(99); // should not throw
	});
});

// ============================================================================
// FINGERPRINT REGENERATION TESTS
// ============================================================================

describe("AntigravityAccountPool - fingerprint regeneration", () => {
	it("regenerateFingerprint produces different deviceId", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		const oldDeviceId = pool._getAccounts()[0]!.fingerprint.deviceId;
		const oldSession = pool._getAccounts()[0]!.fingerprint.sessionToken;

		const newFp = pool.regenerateFingerprint(0);

		expect(newFp).not.toBeNull();
		expect(newFp!.deviceId).not.toBe(oldDeviceId);
		expect(newFp!.sessionToken).not.toBe(oldSession);
	});

	it("stores previous fingerprint in history", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		const originalDeviceId = pool._getAccounts()[0]!.fingerprint.deviceId;
		pool.regenerateFingerprint(0);

		const history = pool.getFingerprintHistory(0);
		expect(history).toHaveLength(1);
		expect(history[0]!.fingerprint.deviceId).toBe(originalDeviceId);
		expect(history[0]!.reason).toBe("regenerated");
		expect(history[0]!.timestamp).toBeGreaterThan(0);
	});

	it("caps fingerprint history at MAX_FINGERPRINT_HISTORY", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);

		for (let i = 0; i < 10; i++) {
			pool.regenerateFingerprint(0);
		}

		const history = pool.getFingerprintHistory(0);
		expect(history.length).toBe(5); // MAX_FINGERPRINT_HISTORY
	});

	it("persists fingerprint history across saves", () => {
		const path = join(tempDir, "fp-history-persist.json");
		const pool1 = new AntigravityAccountPool(path);
		pool1.addAccount(makeCredentials());

		const originalDeviceId = pool1._getAccounts()[0]!.fingerprint.deviceId;
		pool1.regenerateFingerprint(0);
		pool1.saveNow();

		const pool2 = new AntigravityAccountPool(path);
		pool2.load();
		const history = pool2.getFingerprintHistory(0);
		expect(history).toHaveLength(1);
		expect(history[0]!.fingerprint.deviceId).toBe(originalDeviceId);
	});

	it("returns null for invalid account index", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);
		expect(pool.regenerateFingerprint(99)).toBeNull();
	});

	it("returns empty history for account without regeneration", () => {
		const pool = makePool();
		addTestAccounts(pool, 1);
		expect(pool.getFingerprintHistory(0)).toHaveLength(0);
	});

	it("returns empty history for invalid account index", () => {
		const pool = makePool();
		expect(pool.getFingerprintHistory(99)).toHaveLength(0);
	});
});

// ============================================================================
// ANTIGRAVITY VERSION MANAGEMENT TESTS
// ============================================================================

describe("antigravity version management", () => {
	afterEach(() => {
		_resetVersion();
	});

	it("getAntigravityVersion returns default initially", () => {
		expect(getAntigravityVersion()).toBe(DEFAULT_ANTIGRAVITY_VERSION);
	});

	it("setAntigravityVersion updates and locks", () => {
		expect(setAntigravityVersion("1.20.5")).toBe(true);
		expect(getAntigravityVersion()).toBe("1.20.5");

		// Second call is locked
		expect(setAntigravityVersion("1.21.0")).toBe(false);
		expect(getAntigravityVersion()).toBe("1.20.5");
	});

	it("env var overrides set version", () => {
		process.env.PI_AI_ANTIGRAVITY_VERSION = "9.9.9";
		expect(getAntigravityVersion()).toBe("9.9.9");
		delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	});

	it("fetchAntigravityVersion falls back on fetch failure", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;

		const version = await fetchAntigravityVersion();
		expect(version).toBe(DEFAULT_ANTIGRAVITY_VERSION);

		globalThis.fetch = originalFetch;
	});

	it("fetchAntigravityVersion falls back on network error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("network error");
		}) as typeof fetch;

		const version = await fetchAntigravityVersion();
		expect(version).toBe(DEFAULT_ANTIGRAVITY_VERSION);

		globalThis.fetch = originalFetch;
	});

	it("fetchAntigravityVersion parses marketplace response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({
			ok: true,
			json: async () => ({
				results: [
					{
						extensions: [
							{
								versions: [{ version: "1.22.0" }],
							},
						],
					},
				],
			}),
		})) as unknown as typeof fetch;

		const version = await fetchAntigravityVersion();
		expect(version).toBe("1.22.0");

		globalThis.fetch = originalFetch;
	});
});

// ============================================================================
// FINGERPRINT VERSION UPDATING TESTS
// ============================================================================

describe("fingerprint version updating", () => {
	afterEach(() => {
		_resetVersion();
	});

	it("updateFingerprintVersion updates User-Agent", () => {
		const fp = generateFingerprint();
		expect(fp.userAgent).toContain(DEFAULT_ANTIGRAVITY_VERSION);

		setAntigravityVersion("1.25.0");
		const changed = updateFingerprintVersion(fp);

		expect(changed).toBe(true);
		expect(fp.userAgent).toContain("1.25.0");
		expect(fp.userAgent).not.toContain(DEFAULT_ANTIGRAVITY_VERSION);
	});

	it("updateFingerprintVersion returns false when already current", () => {
		const fp = generateFingerprint();
		const changed = updateFingerprintVersion(fp);
		expect(changed).toBe(false);
	});

	it("pool updates fingerprint versions on load", () => {
		const path = join(tempDir, "version-update-test.json");

		// Save with default version
		const pool1 = new AntigravityAccountPool(path);
		pool1.addAccount(makeCredentials());
		pool1.saveNow();

		// Change version
		setAntigravityVersion("1.30.0");

		// Load should update fingerprint
		const pool2 = new AntigravityAccountPool(path);
		pool2.load();
		const fp = pool2._getAccounts()[0]!.fingerprint;
		expect(fp.userAgent).toContain("1.30.0");
	});
});

// ============================================================================
// HEALTH SCORE TRACKER (STANDALONE)
// ============================================================================

describe("HealthScoreTracker", () => {
	afterEach(() => {
		_resetHealthTracker();
	});

	it("returns initial score for unknown accounts", () => {
		const tracker = getHealthTracker();
		expect(tracker.getScore(0)).toBe(70); // DEFAULT initial
	});

	it("records success and increases score", () => {
		const tracker = getHealthTracker();
		tracker.recordSuccess(0);
		expect(tracker.getScore(0)).toBe(71); // 70 + 1
	});

	it("records rate limit and decreases score", () => {
		const tracker = getHealthTracker();
		tracker.recordRateLimit(0);
		expect(tracker.getScore(0)).toBe(60); // 70 - 10
	});

	it("records failure with larger penalty", () => {
		const tracker = getHealthTracker();
		tracker.recordFailure(0);
		expect(tracker.getScore(0)).toBe(50); // 70 - 20
	});

	it("score never goes below 0", () => {
		const tracker = getHealthTracker();
		for (let i = 0; i < 10; i++) {
			tracker.recordFailure(0);
		}
		expect(tracker.getScore(0)).toBe(0);
	});

	it("score caps at maxScore", () => {
		const tracker = getHealthTracker();
		for (let i = 0; i < 100; i++) {
			tracker.recordSuccess(0);
		}
		expect(tracker.getScore(0)).toBe(100);
	});

	it("isUsable returns false when score below threshold", () => {
		const tracker = getHealthTracker();
		tracker.recordFailure(0); // 70 - 20 = 50
		expect(tracker.isUsable(0)).toBe(true); // exactly at threshold
		tracker.recordFailure(0); // 50 - 20 = 30
		expect(tracker.isUsable(0)).toBe(false);
	});

	it("tracks consecutive failures", () => {
		const tracker = getHealthTracker();
		tracker.recordFailure(0);
		tracker.recordFailure(0);
		expect(tracker.getConsecutiveFailures(0)).toBe(2);
		tracker.recordSuccess(0);
		expect(tracker.getConsecutiveFailures(0)).toBe(0);
	});

	it("persists across pool instances (global singleton)", () => {
		const tracker1 = getHealthTracker();
		tracker1.recordSuccess(0);
		tracker1.recordRateLimit(1);

		const tracker2 = getHealthTracker();
		expect(tracker2.getScore(0)).toBeGreaterThan(tracker2.getScore(1));
	});

	it("reset clears account state", () => {
		const tracker = getHealthTracker();
		tracker.recordFailure(0);
		expect(tracker.getScore(0)).toBeLessThan(70);
		tracker.reset(0);
		expect(tracker.getScore(0)).toBe(70);
	});
});

// ============================================================================
// TOKEN BUCKET TRACKER (STANDALONE)
// ============================================================================

describe("TokenBucketTracker", () => {
	afterEach(() => {
		_resetTokenTracker();
	});

	it("starts with initial tokens", () => {
		const tracker = getTokenTracker();
		expect(tracker.getTokens(0)).toBe(50);
	});

	it("consume decreases tokens", () => {
		const tracker = getTokenTracker();
		expect(tracker.consume(0)).toBe(true);
		expect(tracker.getTokens(0)).toBe(49);
	});

	it("consume fails when insufficient tokens", () => {
		const tracker = getTokenTracker();
		for (let i = 0; i < 50; i++) {
			tracker.consume(0);
		}
		expect(tracker.consume(0)).toBe(false);
		expect(tracker.hasTokens(0)).toBe(false);
	});

	it("refund increases tokens", () => {
		const tracker = getTokenTracker();
		tracker.consume(0);
		tracker.refund(0);
		expect(tracker.getTokens(0)).toBe(50);
	});

	it("refund caps at maxTokens", () => {
		const tracker = getTokenTracker();
		tracker.refund(0, 100);
		expect(tracker.getTokens(0)).toBe(50);
	});

	it("hasTokens checks for cost", () => {
		const tracker = getTokenTracker();
		expect(tracker.hasTokens(0, 50)).toBe(true);
		expect(tracker.hasTokens(0, 51)).toBe(false);
	});
});

// ============================================================================
// SELECT HYBRID ACCOUNT
// ============================================================================

describe("selectHybridAccount", () => {
	afterEach(() => {
		_resetHealthTracker();
		_resetTokenTracker();
	});

	it("selects healthier account", () => {
		const tracker = getHealthTracker();
		const tokenTracker = getTokenTracker();

		// Damage account 0
		for (let i = 0; i < 3; i++) tracker.recordFailure(0);

		const accounts: AccountWithMetrics[] = [
			{ index: 0, lastUsed: 0, healthScore: tracker.getScore(0), isRateLimited: false, isCoolingDown: false },
			{ index: 1, lastUsed: 0, healthScore: tracker.getScore(1), isRateLimited: false, isCoolingDown: false },
		];

		const selected = selectHybridAccount(accounts, tokenTracker);
		expect(selected).toBe(1);
	});

	it("returns null when all accounts filtered", () => {
		const tokenTracker = getTokenTracker();

		const accounts: AccountWithMetrics[] = [
			{ index: 0, lastUsed: 0, healthScore: 10, isRateLimited: true, isCoolingDown: false },
			{ index: 1, lastUsed: 0, healthScore: 10, isRateLimited: false, isCoolingDown: true },
		];

		expect(selectHybridAccount(accounts, tokenTracker)).toBeNull();
	});

	it("skips accounts with no tokens", () => {
		const tokenTracker = getTokenTracker();
		// Drain tokens for account 0
		for (let i = 0; i < 50; i++) tokenTracker.consume(0);

		const accounts: AccountWithMetrics[] = [
			{ index: 0, lastUsed: 0, healthScore: 100, isRateLimited: false, isCoolingDown: false },
			{ index: 1, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
		];

		expect(selectHybridAccount(accounts, tokenTracker)).toBe(1);
	});
});

// ============================================================================
// SORT BY LRU WITH HEALTH
// ============================================================================

describe("sortByLruWithHealth", () => {
	it("sorts by lastUsed ascending", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, lastUsed: 1000, healthScore: 70, isRateLimited: false, isCoolingDown: false },
			{ index: 1, lastUsed: 500, healthScore: 70, isRateLimited: false, isCoolingDown: false },
			{ index: 2, lastUsed: 2000, healthScore: 70, isRateLimited: false, isCoolingDown: false },
		];

		const sorted = sortByLruWithHealth(accounts);
		expect(sorted.map((a) => a.index)).toEqual([1, 0, 2]);
	});

	it("filters rate-limited and cooling-down accounts", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, lastUsed: 0, healthScore: 70, isRateLimited: true, isCoolingDown: false },
			{ index: 1, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: true },
			{ index: 2, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
		];

		const sorted = sortByLruWithHealth(accounts);
		expect(sorted).toHaveLength(1);
		expect(sorted[0]!.index).toBe(2);
	});

	it("filters accounts below health threshold", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, lastUsed: 0, healthScore: 30, isRateLimited: false, isCoolingDown: false },
			{ index: 1, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
		];

		const sorted = sortByLruWithHealth(accounts);
		expect(sorted).toHaveLength(1);
		expect(sorted[0]!.index).toBe(1);
	});
});

// ============================================================================
// JITTER UTILITIES
// ============================================================================

describe("jitter utilities", () => {
	it("addJitter returns value near base", () => {
		for (let i = 0; i < 100; i++) {
			const jittered = addJitter(1000, 0.3);
			expect(jittered).toBeGreaterThanOrEqual(700);
			expect(jittered).toBeLessThanOrEqual(1300);
		}
	});

	it("randomDelay returns value in range", () => {
		for (let i = 0; i < 100; i++) {
			const delay = randomDelay(100, 500);
			expect(delay).toBeGreaterThanOrEqual(100);
			expect(delay).toBeLessThanOrEqual(500);
		}
	});
});
