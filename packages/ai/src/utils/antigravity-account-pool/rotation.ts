/**
 * Health scoring, token bucket tracking, and hybrid account selection.
 *
 * Standalone trackers that can be used independently of AntigravityAccountPool
 * for lightweight health/token tracking in the provider request loop.
 */

// ============================================================================
// HEALTH SCORE TRACKER
// ============================================================================

export interface HealthScoreConfig {
	initialScore: number;
	successReward: number;
	rateLimitPenalty: number;
	failurePenalty: number;
	minUsable: number;
	maxScore: number;
}

export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
	initialScore: 70,
	successReward: 1,
	rateLimitPenalty: 10,
	failurePenalty: 20,
	minUsable: 50,
	maxScore: 100,
};

interface AccountHealthState {
	score: number;
	consecutiveFailures: number;
	lastUpdated: number;
}

export class HealthScoreTracker {
	private state = new Map<number, AccountHealthState>();

	constructor(private config: HealthScoreConfig = DEFAULT_HEALTH_SCORE_CONFIG) {}

	private getOrCreate(accountIndex: number): AccountHealthState {
		let entry = this.state.get(accountIndex);
		if (!entry) {
			entry = {
				score: this.config.initialScore,
				consecutiveFailures: 0,
				lastUpdated: Date.now(),
			};
			this.state.set(accountIndex, entry);
		}
		return entry;
	}

	getScore(accountIndex: number): number {
		return this.getOrCreate(accountIndex).score;
	}

	recordSuccess(accountIndex: number): void {
		const entry = this.getOrCreate(accountIndex);
		entry.score = Math.min(this.config.maxScore, entry.score + this.config.successReward);
		entry.consecutiveFailures = 0;
		entry.lastUpdated = Date.now();
	}

	recordRateLimit(accountIndex: number): void {
		const entry = this.getOrCreate(accountIndex);
		entry.score = Math.max(0, entry.score - this.config.rateLimitPenalty);
		entry.consecutiveFailures++;
		entry.lastUpdated = Date.now();
	}

	recordFailure(accountIndex: number): void {
		const entry = this.getOrCreate(accountIndex);
		entry.score = Math.max(0, entry.score - this.config.failurePenalty);
		entry.consecutiveFailures++;
		entry.lastUpdated = Date.now();
	}

	isUsable(accountIndex: number): boolean {
		return this.getScore(accountIndex) >= this.config.minUsable;
	}

	getConsecutiveFailures(accountIndex: number): number {
		return this.getOrCreate(accountIndex).consecutiveFailures;
	}

	reset(accountIndex: number): void {
		this.state.delete(accountIndex);
	}

	getSnapshot(): Map<number, { score: number; consecutiveFailures: number }> {
		const snapshot = new Map<number, { score: number; consecutiveFailures: number }>();
		for (const [key, val] of this.state) {
			snapshot.set(key, { score: val.score, consecutiveFailures: val.consecutiveFailures });
		}
		return snapshot;
	}
}

// ============================================================================
// TOKEN BUCKET TRACKER
// ============================================================================

export interface TokenBucketConfig {
	initialTokens: number;
	maxTokens: number;
}

export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
	initialTokens: 50,
	maxTokens: 50,
};

export class TokenBucketTracker {
	private buckets = new Map<number, number>();

	constructor(private config: TokenBucketConfig = DEFAULT_TOKEN_BUCKET_CONFIG) {}

	private getOrCreate(accountIndex: number): number {
		let tokens = this.buckets.get(accountIndex);
		if (tokens === undefined) {
			tokens = this.config.initialTokens;
			this.buckets.set(accountIndex, tokens);
		}
		return tokens;
	}

	getTokens(accountIndex: number): number {
		return this.getOrCreate(accountIndex);
	}

	hasTokens(accountIndex: number, cost: number = 1): boolean {
		return this.getOrCreate(accountIndex) >= cost;
	}

	consume(accountIndex: number, cost: number = 1): boolean {
		const current = this.getOrCreate(accountIndex);
		if (current < cost) return false;
		this.buckets.set(accountIndex, current - cost);
		return true;
	}

	refund(accountIndex: number, amount: number = 1): void {
		const current = this.getOrCreate(accountIndex);
		this.buckets.set(accountIndex, Math.min(this.config.maxTokens, current + amount));
	}

	getMaxTokens(): number {
		return this.config.maxTokens;
	}
}

// ============================================================================
// ACCOUNT WITH METRICS
// ============================================================================

export interface AccountWithMetrics {
	index: number;
	lastUsed: number;
	healthScore: number;
	isRateLimited: boolean;
	isCoolingDown: boolean;
}

// ============================================================================
// SORTING & SELECTION
// ============================================================================

/**
 * Filter and sort accounts by LRU order, removing rate-limited,
 * cooling-down, and unhealthy accounts.
 */
export function sortByLruWithHealth(
	accounts: AccountWithMetrics[],
	healthThreshold: number = DEFAULT_HEALTH_SCORE_CONFIG.minUsable,
): AccountWithMetrics[] {
	return accounts
		.filter((a) => !a.isRateLimited && !a.isCoolingDown && a.healthScore >= healthThreshold)
		.sort((a, b) => a.lastUsed - b.lastUsed);
}

/**
 * Select the best account using a hybrid health + token strategy.
 *
 * 1. Filter out rate-limited, cooling-down, and unhealthy accounts
 * 2. Filter out accounts with no tokens
 * 3. Sort by health score descending (prefer healthier accounts)
 * 4. Return the best account's index, or null if none available
 */
export function selectHybridAccount(
	accounts: AccountWithMetrics[],
	tokenTracker: TokenBucketTracker,
	healthThreshold: number = DEFAULT_HEALTH_SCORE_CONFIG.minUsable,
): number | null {
	const available = accounts
		.filter((a) => !a.isRateLimited && !a.isCoolingDown && a.healthScore >= healthThreshold)
		.filter((a) => tokenTracker.hasTokens(a.index))
		.sort((a, b) => {
			// Sort by health score descending
			const healthDiff = b.healthScore - a.healthScore;
			if (healthDiff !== 0) return healthDiff;
			// Tie-break by LRU (least recently used first)
			return a.lastUsed - b.lastUsed;
		});

	if (available.length === 0) return null;
	return available[0]!.index;
}

// ============================================================================
// JITTER UTILITIES
// ============================================================================

/**
 * Add random jitter to a base value.
 * @param baseMs - Base value in milliseconds
 * @param factor - Jitter factor (0.3 = ±30%)
 * @returns Jittered value
 */
export function addJitter(baseMs: number, factor: number = 0.3): number {
	const jitter = baseMs * factor;
	return baseMs - jitter + Math.random() * 2 * jitter;
}

/**
 * Generate a random delay between min and max milliseconds.
 */
export function randomDelay(minMs: number, maxMs: number): number {
	return minMs + Math.random() * (maxMs - minMs);
}

// ============================================================================
// SINGLETON MANAGEMENT
// ============================================================================

let healthTrackerInstance: HealthScoreTracker | null = null;
let tokenTrackerInstance: TokenBucketTracker | null = null;

/**
 * Get the global HealthScoreTracker singleton.
 * Creates one with default config if not initialized.
 */
export function getHealthTracker(): HealthScoreTracker {
	if (!healthTrackerInstance) {
		healthTrackerInstance = new HealthScoreTracker();
	}
	return healthTrackerInstance;
}

/**
 * Initialize the global HealthScoreTracker with custom config.
 * Returns existing instance if already initialized.
 */
export function initHealthTracker(config?: HealthScoreConfig): HealthScoreTracker {
	if (!healthTrackerInstance) {
		healthTrackerInstance = new HealthScoreTracker(config);
	}
	return healthTrackerInstance;
}

/**
 * Get the global TokenBucketTracker singleton.
 * Creates one with default config if not initialized.
 */
export function getTokenTracker(): TokenBucketTracker {
	if (!tokenTrackerInstance) {
		tokenTrackerInstance = new TokenBucketTracker();
	}
	return tokenTrackerInstance;
}

/**
 * Initialize the global TokenBucketTracker with custom config.
 * Returns existing instance if already initialized.
 */
export function initTokenTracker(config?: TokenBucketConfig): TokenBucketTracker {
	if (!tokenTrackerInstance) {
		tokenTrackerInstance = new TokenBucketTracker(config);
	}
	return tokenTrackerInstance;
}

/** @internal Test helper — reset health tracker singleton */
export function _resetHealthTracker(): void {
	healthTrackerInstance = null;
}

/** @internal Test helper — reset token tracker singleton */
export function _resetTokenTracker(): void {
	tokenTrackerInstance = null;
}
