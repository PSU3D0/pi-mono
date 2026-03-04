/**
 * Antigravity multi-account pool system.
 *
 * Provides intelligent account rotation, rate limit tracking,
 * health scoring, and device fingerprinting for Google Cloud
 * Code Assist (Antigravity) accounts.
 */

export { AntigravityAccountPool } from "./account-pool.js";
export {
	buildFingerprintHeaders,
	generateFingerprint,
	MAX_FINGERPRINT_HISTORY,
	updateFingerprintVersion,
} from "./fingerprint.js";
export {
	calculateBackoffMs,
	clearExpiredRateLimits,
	getAvailableHeaderStyle,
	getMinWaitTimeForFamily,
	getQuotaKey,
	isRateLimitedForFamily,
	isRateLimitedForHeaderStyle,
	parseRateLimitReason,
} from "./rate-limits.js";
export {
	_resetHealthTracker,
	_resetTokenTracker,
	type AccountWithMetrics,
	addJitter,
	getHealthTracker,
	getTokenTracker,
	type HealthScoreConfig,
	HealthScoreTracker,
	initHealthTracker,
	initTokenTracker,
	randomDelay,
	selectHybridAccount,
	sortByLruWithHealth,
	type TokenBucketConfig,
	TokenBucketTracker,
} from "./rotation.js";
export { createEmptyStorage, loadAccountPool, saveAccountPool } from "./storage.js";
export type {
	AccountInfo,
	AccountPoolStorage,
	AccountSelection,
	AccountSelectionStrategy,
	BaseQuotaKey,
	CooldownReason,
	DeviceFingerprint,
	FingerprintVersion,
	HeaderStyle,
	ModelFamily,
	PoolAccount,
	QuotaKey,
	RateLimitReason,
	RateLimitState,
	StoredAccount,
	SwitchReason,
} from "./types.js";
export { extractVerificationError, type VerificationResult } from "./verification.js";
export {
	_resetVersion,
	DEFAULT_ANTIGRAVITY_VERSION,
	fetchAntigravityVersion,
	getAntigravityVersion,
	setAntigravityVersion,
} from "./version.js";
