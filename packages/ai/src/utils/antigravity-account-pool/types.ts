/**
 * Types for the Antigravity multi-account pool system.
 *
 * Supports up to N Google accounts with independent rate limit tracking,
 * health scoring, device fingerprinting, and token rotation.
 */

/** Model family for quota tracking */
export type ModelFamily = "claude" | "gemini";

/** Header style determines which quota pool is consumed */
export type HeaderStyle = "antigravity";

/** Rate limit state: maps quota keys to reset timestamps (ms) */
export type RateLimitState = Record<string, number>;

/** Why an account was switched to */
export type SwitchReason = "rate-limit" | "initial" | "rotation";

/** Why an account is cooling down */
export type CooldownReason = "verification" | "auth-failure" | "repeated-failure" | "validation-required";

/** Account selection strategy */
export type AccountSelectionStrategy = "sticky" | "round-robin" | "hybrid";

/** A snapshot of a fingerprint with metadata about when/why it was saved */
export interface FingerprintVersion {
	fingerprint: DeviceFingerprint;
	timestamp: number;
	reason: "initial" | "regenerated" | "restored";
}

/** Device fingerprint for rate limit mitigation */
export interface DeviceFingerprint {
	deviceId: string;
	sessionToken: string;
	userAgent: string;
	apiClient: string;
	clientMetadata: {
		ideType: string;
		platform: string;
		pluginType: string;
	};
	createdAt: number;
}

/** A single managed account in the pool */
export interface PoolAccount {
	index: number;
	email?: string;
	refreshToken: string;
	projectId?: string;
	accessToken?: string;
	accessTokenExpires?: number;
	addedAt: number;
	lastUsed: number;
	enabled: boolean;
	rateLimitResetTimes: RateLimitState;
	lastSwitchReason?: SwitchReason;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	consecutiveFailures: number;
	lastFailureTime?: number;
	fingerprint: DeviceFingerprint;
	fingerprintHistory?: FingerprintVersion[];
	healthScore: number;
	verificationRequired?: boolean;
	verificationRequiredAt?: number;
	verificationReason?: string;
	verificationUrl?: string;
}

/** Serialized account for persistence */
export interface StoredAccount {
	email?: string;
	refreshToken: string;
	projectId?: string;
	addedAt: number;
	lastUsed: number;
	enabled: boolean;
	rateLimitResetTimes?: RateLimitState;
	lastSwitchReason?: SwitchReason;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	fingerprint?: DeviceFingerprint;
	fingerprintHistory?: FingerprintVersion[];
	healthScore?: number;
	consecutiveFailures?: number;
	verificationRequired?: boolean;
	verificationRequiredAt?: number;
	verificationReason?: string;
	verificationUrl?: string;
}

/** Storage format v1 (pi-native, simpler than opencode's v4) */
export interface AccountPoolStorage {
	version: 1;
	accounts: StoredAccount[];
	activeIndex: number;
	activeIndexByFamily: Record<ModelFamily, number>;
}

/** Quota key types: base or model-specific */
export type BaseQuotaKey = "claude" | "gemini-antigravity";
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

/** Result of account selection */
export interface AccountSelection {
	account: PoolAccount;
	headerStyle: HeaderStyle;
	switched: boolean;
	switchReason?: SwitchReason;
}

/** Rate limit classification */
export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

/** Summary info for displaying account status */
export interface AccountInfo {
	index: number;
	email?: string;
	enabled: boolean;
	healthScore: number;
	isRateLimited: boolean;
	isCoolingDown: boolean;
	lastUsed: number;
	addedAt: number;
	activeForFamilies: ModelFamily[];
	rateLimitKeys: string[];
}
