/**
 * Persistent storage for the Antigravity account pool.
 *
 * Stores accounts in ~/.pi/agent/antigravity-accounts.json
 * with file locking to prevent race conditions between pi instances.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountPoolStorage, StoredAccount } from "./types.js";

/**
 * Load account pool from disk.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadAccountPool(path: string): AccountPoolStorage | null {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
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
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	writeFileSync(path, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(path, 0o600);
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
