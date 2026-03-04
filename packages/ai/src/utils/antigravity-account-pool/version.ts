/**
 * Dynamic antigravity version management.
 * Fetches the current Antigravity extension version and provides a locked-once setter.
 */

export const DEFAULT_ANTIGRAVITY_VERSION = "1.18.3";

let currentVersion = DEFAULT_ANTIGRAVITY_VERSION;
let locked = false;

/**
 * Get the current antigravity version.
 * Respects PI_AI_ANTIGRAVITY_VERSION env var as override.
 */
export function getAntigravityVersion(): string {
	return process.env.PI_AI_ANTIGRAVITY_VERSION || currentVersion;
}

/**
 * Set the antigravity version. Only works once (first call locks it).
 * Returns true if the version was set, false if already locked.
 */
export function setAntigravityVersion(version: string): boolean {
	if (locked) return false;
	currentVersion = version;
	locked = true;
	return true;
}

/**
 * Reset version state (for testing only).
 */
export function _resetVersion(): void {
	currentVersion = DEFAULT_ANTIGRAVITY_VERSION;
	locked = false;
}

/**
 * Fetch the current Antigravity extension version from VS Code marketplace.
 * Falls back to DEFAULT_ANTIGRAVITY_VERSION on failure.
 */
export async function fetchAntigravityVersion(): Promise<string> {
	try {
		const resp = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=6.0-preview.1",
			},
			body: JSON.stringify({
				filters: [{ criteria: [{ filterType: 7, value: "Google.gemicode" }] }],
				flags: 0x1,
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (resp.ok) {
			const data = (await resp.json()) as {
				results?: Array<{
					extensions?: Array<{
						versions?: Array<{ version?: string }>;
					}>;
				}>;
			};
			const version = data?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
			if (version && typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
				return version;
			}
		}
	} catch {
		// Fall through to default
	}
	return DEFAULT_ANTIGRAVITY_VERSION;
}
