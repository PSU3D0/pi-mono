/**
 * Rate limit tracking and backoff calculation for Antigravity accounts.
 *
 * Tracks rate limits per-account, per-model, per-header-style to enable
 * intelligent account rotation on 429 responses.
 */

import type { BaseQuotaKey, HeaderStyle, ModelFamily, QuotaKey, RateLimitReason, RateLimitState } from "./types.js";

// ============================================================================
// QUOTA KEY RESOLUTION
// ============================================================================

/**
 * Build a quota key for rate limit tracking.
 * Format: "claude" | "gemini-antigravity" | "{base}:{model}"
 */
export function getQuotaKey(family: ModelFamily, _headerStyle: HeaderStyle, model?: string | null): QuotaKey {
	if (family === "claude") {
		return "claude";
	}
	const base: BaseQuotaKey = "gemini-antigravity";
	if (model) {
		return `${base}:${model}`;
	}
	return base;
}

// ============================================================================
// RATE LIMIT CHECKING
// ============================================================================

/**
 * Clear expired rate limits from an account's state.
 */
export function clearExpiredRateLimits(rateLimits: RateLimitState): void {
	const now = Date.now();
	for (const key of Object.keys(rateLimits)) {
		const resetTime = rateLimits[key];
		if (resetTime !== undefined && now >= resetTime) {
			delete rateLimits[key];
		}
	}
}

/**
 * Check if a specific quota key is rate limited.
 */
export function isRateLimitedForQuotaKey(rateLimits: RateLimitState, key: QuotaKey): boolean {
	const resetTime = rateLimits[key];
	return resetTime !== undefined && Date.now() < resetTime;
}

/**
 * Check if rate limited for a specific header style.
 */
export function isRateLimitedForHeaderStyle(
	rateLimits: RateLimitState,
	family: ModelFamily,
	headerStyle: HeaderStyle,
	model?: string | null,
): boolean {
	clearExpiredRateLimits(rateLimits);

	if (family === "claude") {
		return isRateLimitedForQuotaKey(rateLimits, "claude");
	}

	// Check model-specific quota first
	if (model) {
		const modelKey = getQuotaKey(family, headerStyle, model);
		if (isRateLimitedForQuotaKey(rateLimits, modelKey)) {
			return true;
		}
	}

	// Then check base family quota
	const baseKey = getQuotaKey(family, headerStyle);
	return isRateLimitedForQuotaKey(rateLimits, baseKey);
}

/**
 * Check if rate limited for a model family.
 * For gemini, limited when antigravity quota is exhausted.
 */
export function isRateLimitedForFamily(
	rateLimits: RateLimitState,
	family: ModelFamily,
	model?: string | null,
): boolean {
	return isRateLimitedForHeaderStyle(rateLimits, family, "antigravity", model);
}

/**
 * Get the available header style for a model family.
 * Returns null if antigravity is rate limited.
 */
export function getAvailableHeaderStyle(
	rateLimits: RateLimitState,
	family: ModelFamily,
	model?: string | null,
): HeaderStyle | null {
	clearExpiredRateLimits(rateLimits);

	if (!isRateLimitedForHeaderStyle(rateLimits, family, "antigravity", model)) {
		return "antigravity";
	}
	return null;
}

// ============================================================================
// RATE LIMIT REASON PARSING
// ============================================================================

/**
 * Parse the reason for a rate limit from HTTP response details.
 */
export function parseRateLimitReason(
	reason: string | undefined,
	message: string | undefined,
	status?: number,
): RateLimitReason {
	// Status code checks
	if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED";
	if (status === 500) return "SERVER_ERROR";

	// Explicit reason string
	if (reason) {
		const upper = reason.toUpperCase();
		if (upper === "QUOTA_EXHAUSTED") return "QUOTA_EXHAUSTED";
		if (upper === "RATE_LIMIT_EXCEEDED") return "RATE_LIMIT_EXCEEDED";
		if (upper === "MODEL_CAPACITY_EXHAUSTED") return "MODEL_CAPACITY_EXHAUSTED";
	}

	// Message text scanning
	if (message) {
		const lower = message.toLowerCase();
		if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) {
			return "MODEL_CAPACITY_EXHAUSTED";
		}
		if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
			return "RATE_LIMIT_EXCEEDED";
		}
		if (lower.includes("exhausted") || lower.includes("quota")) {
			return "QUOTA_EXHAUSTED";
		}
	}

	if (status === 429) return "UNKNOWN";
	return "UNKNOWN";
}

// ============================================================================
// BACKOFF CALCULATION
// ============================================================================

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
const MODEL_CAPACITY_BASE_BACKOFF = 45_000;
const MODEL_CAPACITY_JITTER_MAX = 30_000;
const SERVER_ERROR_BACKOFF = 20_000;
const UNKNOWN_BACKOFF = 60_000;
const MIN_BACKOFF_MS = 2_000;

/**
 * Calculate backoff duration for a rate limit hit.
 */
export function calculateBackoffMs(
	reason: RateLimitReason,
	consecutiveFailures: number,
	retryAfterMs?: number | null,
): number {
	// Respect explicit Retry-After header
	if (retryAfterMs && retryAfterMs > 0) {
		return Math.max(retryAfterMs, MIN_BACKOFF_MS);
	}

	switch (reason) {
		case "QUOTA_EXHAUSTED": {
			const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
			return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF;
		}
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF;
		case "MODEL_CAPACITY_EXHAUSTED": {
			const jitter = Math.random() * MODEL_CAPACITY_JITTER_MAX - MODEL_CAPACITY_JITTER_MAX / 2;
			return MODEL_CAPACITY_BASE_BACKOFF + jitter;
		}
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF;
		default:
			return UNKNOWN_BACKOFF;
	}
}

/**
 * Get the minimum wait time across all accounts for a family.
 * Returns 0 if any account is available.
 */
export function getMinWaitTimeForFamily(
	accountRateLimits: RateLimitState[],
	family: ModelFamily,
	model?: string | null,
): number {
	// Check if any account is available
	for (const rateLimits of accountRateLimits) {
		clearExpiredRateLimits(rateLimits);
		if (!isRateLimitedForFamily(rateLimits, family, model)) {
			return 0;
		}
	}

	// All accounts limited - find minimum wait
	const now = Date.now();
	const waitTimes: number[] = [];

	for (const rateLimits of accountRateLimits) {
		if (family === "claude") {
			const t = rateLimits.claude;
			if (t !== undefined) waitTimes.push(Math.max(0, t - now));
		} else {
			const keys = Object.keys(rateLimits).filter(
				(k) => k.startsWith("gemini-antigravity") || (model && k.includes(model)),
			);
			for (const key of keys) {
				const t = rateLimits[key];
				if (t !== undefined) waitTimes.push(Math.max(0, t - now));
			}
		}
	}

	return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
}
