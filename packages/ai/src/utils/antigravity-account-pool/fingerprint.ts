/**
 * Device fingerprint generation for Antigravity accounts.
 *
 * Each account gets a unique fingerprint to reduce the risk of
 * correlated rate limiting across accounts. Mimics realistic
 * client diversity (different platforms, versions, etc.).
 */

import crypto from "node:crypto";
import type { DeviceFingerprint } from "./types.js";
import { getAntigravityVersion } from "./version.js";

/** Maximum number of fingerprint versions to keep per account */
export const MAX_FINGERPRINT_HISTORY = 5;

const ANTIGRAVITY_PLATFORMS = ["windows/amd64", "darwin/arm64", "darwin/amd64"] as const;

const ANTIGRAVITY_API_CLIENTS = [
	"google-cloud-sdk vscode_cloudshelleditor/0.1",
	"google-cloud-sdk vscode/1.96.0",
	"google-cloud-sdk vscode/1.95.0",
	"google-cloud-sdk vscode/1.86.0",
] as const;

function randomFrom<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Generate a unique device fingerprint for an account.
 */
export function generateFingerprint(): DeviceFingerprint {
	const platform = randomFrom(ANTIGRAVITY_PLATFORMS);
	const metadataPlatform = platform.startsWith("windows") ? "WINDOWS" : "MACOS";
	const version = getAntigravityVersion();

	return {
		deviceId: crypto.randomUUID(),
		sessionToken: crypto.randomBytes(16).toString("hex"),
		userAgent: `antigravity/${version} ${platform}`,
		apiClient: randomFrom(ANTIGRAVITY_API_CLIENTS),
		clientMetadata: {
			ideType: "ANTIGRAVITY",
			platform: metadataPlatform,
			pluginType: "GEMINI",
		},
		createdAt: Date.now(),
	};
}

/**
 * Build request headers from a fingerprint.
 */
export function buildFingerprintHeaders(fingerprint: DeviceFingerprint): Record<string, string> {
	return {
		"User-Agent": fingerprint.userAgent,
	};
}

/**
 * Update a fingerprint's User-Agent to use the current antigravity version.
 * Returns true if the version was changed.
 */
export function updateFingerprintVersion(fingerprint: DeviceFingerprint): boolean {
	const currentVersion = getAntigravityVersion();
	const versionRegex = /antigravity\/[\d.]+/;
	const match = fingerprint.userAgent.match(versionRegex);

	if (match && match[0] === `antigravity/${currentVersion}`) {
		return false; // Already current
	}

	fingerprint.userAgent = fingerprint.userAgent.replace(versionRegex, `antigravity/${currentVersion}`);
	return true;
}
