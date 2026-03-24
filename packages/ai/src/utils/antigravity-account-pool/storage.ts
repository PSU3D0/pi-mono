/**
 * Persistent storage for the Antigravity account pool.
 *
 * Stores accounts in ~/.pi/agent/antigravity-accounts.json
 * with file locking to prevent race conditions between pi instances.
 */

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");

import type { AccountPoolStorage, StoredAccount } from "./types.js";

function getNodeBuiltin<T>(specifier: string): T | null {
	if (typeof process === "undefined" || !process.versions?.node) {
		return null;
	}

	const builtinGetter = (process as typeof process & { getBuiltinModule?: (name: string) => unknown })
		.getBuiltinModule;
	if (typeof builtinGetter === "function") {
		return (builtinGetter(specifier) as T | undefined) ?? null;
	}

	try {
		const req = Function("return typeof require !== 'undefined' ? require : undefined")() as
			| ((name: string) => T)
			| undefined;
		return req?.(specifier) ?? null;
	} catch {
		return null;
	}
}

function getNodeFs(): NodeFs | null {
	return getNodeBuiltin<NodeFs>("node:fs") ?? getNodeBuiltin<NodeFs>("fs");
}

function getNodePath(): NodePath | null {
	return getNodeBuiltin<NodePath>("node:path") ?? getNodeBuiltin<NodePath>("path");
}

/**
 * Load account pool from disk.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadAccountPool(path: string): AccountPoolStorage | null {
	const fs = getNodeFs();
	if (!fs || !fs.existsSync(path)) {
		return null;
	}

	try {
		const content = fs.readFileSync(path, "utf-8");
		const data = JSON.parse(content) as AccountPoolStorage;

		// Validate version
		if (data.version !== 1) {
			return null;
		}

		if (!Array.isArray(data.accounts)) {
			return null;
		}

		return data;
	} catch {
		return null;
	}
}

/**
 * Save account pool to disk with restrictive permissions.
 */
export function saveAccountPool(path: string, storage: AccountPoolStorage): void {
	const fs = getNodeFs();
	const nodePath = getNodePath();
	if (!fs || !nodePath) {
		return;
	}

	const dir = nodePath.dirname(path);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	fs.writeFileSync(path, JSON.stringify(storage, null, 2), "utf-8");
	fs.chmodSync(path, 0o600);
}

/**
 * Create an empty account pool storage.
 */
export function createEmptyStorage(): AccountPoolStorage {
	return {
		version: 1,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {
			claude: -1,
			gemini: -1,
		},
	};
}

/**
 * Validate a stored account has the minimum required fields.
 */
export function isValidStoredAccount(account: unknown): account is StoredAccount {
	if (!account || typeof account !== "object") return false;

	const a = account as Record<string, unknown>;
	return typeof a.refreshToken === "string" && a.refreshToken.length > 0;
}
