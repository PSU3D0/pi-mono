import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createSessionFile(path: string): void {
	const header = createHeader();
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	// SessionManager only persists once it has seen at least one assistant message.
	// Add a minimal assistant entry so subsequent appends are persisted.
	const mgr = SessionManager.open(path);
	mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function createHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
	return {
		type: "session",
		id: "test-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
		...overrides,
	};
}

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessageEntry(
	id: string,
	parentId: string | null,
	entryTime: number,
	messageTime: number,
	text: string,
) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(entryTime).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: usage(),
			stopReason: "stop",
			timestamp: messageTime,
		},
	};
}

function sessionInfoEntry(id: string, parentId: string | null, time: number, name: string | undefined) {
	return {
		type: "session_info",
		id,
		parentId,
		timestamp: new Date(time).toISOString(),
		name,
	};
}

function customEntry(id: string, parentId: string | null, time: number, data: unknown) {
	return {
		type: "custom",
		customType: "test",
		data,
		id,
		parentId,
		timestamp: new Date(time).toISOString(),
	};
}

function writeJsonl(path: string, entries: unknown[]): void {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function listedSession(filePath: string) {
	const sessions = await SessionManager.list("/tmp", dirname(filePath));
	const session = sessions.find((x) => x.path === filePath);
	expect(session).toBeDefined();
	return session!;
}

describe("SessionInfo.modified", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses last user/assistant message timestamp instead of file mtime", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-modified.jsonl`);
		createSessionFile(filePath);

		const before = await stat(filePath);
		// Ensure the file mtime can differ from our message timestamp even on coarse filesystems.
		await new Promise((r) => setTimeout(r, 10));

		const mgr = SessionManager.open(filePath);
		const msgTime = Date.now();
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "later" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: msgTime,
		});

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.modified.getTime()).toBe(msgTime);
		expect(s!.modified.getTime()).not.toBe(before.mtime.getTime());
	});

	it("finds activity in a final JSONL record larger than the old fixed tail chunk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-tail-large-final-"));
		const filePath = join(dir, "session.jsonl");
		const oldTime = Date.UTC(2026, 0, 1, 0, 0, 0);
		const latestTime = Date.UTC(2026, 0, 2, 0, 0, 0);

		writeJsonl(filePath, [
			createHeader(),
			assistantMessageEntry("old", null, oldTime, oldTime, "old"),
			assistantMessageEntry("latest", "old", latestTime, latestTime, "x".repeat(20_000)),
		]);

		const session = await listedSession(filePath);
		expect(session.modified.getTime()).toBe(latestTime);
	});

	it("sorts sessions by activity discovered in large tail records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-tail-sort-"));
		const olderPath = join(dir, "older.jsonl");
		const largeTailPath = join(dir, "large-tail.jsonl");
		const oldTime = Date.UTC(2026, 0, 1, 0, 0, 0);
		const olderActivityTime = Date.UTC(2026, 0, 2, 0, 0, 0);
		const newestActivityTime = Date.UTC(2026, 0, 3, 0, 0, 0);

		writeJsonl(olderPath, [
			createHeader({ id: "older" }),
			assistantMessageEntry("older-msg", null, olderActivityTime, olderActivityTime, "older"),
		]);
		writeJsonl(largeTailPath, [
			createHeader({ id: "large-tail" }),
			assistantMessageEntry("old", null, oldTime, oldTime, "old"),
			assistantMessageEntry("newest", "old", newestActivityTime, newestActivityTime, "x".repeat(20_000)),
		]);

		const sessions = await SessionManager.list("/tmp", dir);
		expect(sessions.map((session) => session.path)).toEqual([largeTailPath, olderPath]);
	});

	it("continues past tail metadata to find the latest activity and scanned session name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-tail-metadata-"));
		const filePath = join(dir, "session.jsonl");
		const oldTime = Date.UTC(2026, 0, 1, 0, 0, 0);
		const activityTime = Date.UTC(2026, 0, 3, 0, 0, 0);
		const metadataTime = activityTime + 5_000;

		writeJsonl(filePath, [
			createHeader(),
			assistantMessageEntry("old", null, oldTime, oldTime, "old"),
			customEntry("head-padding", "old", oldTime + 1_000, { text: "p".repeat(12_000) }),
			assistantMessageEntry("activity", "head-padding", activityTime, activityTime, "latest activity"),
			sessionInfoEntry("name", "activity", metadataTime, "Tail Name"),
			customEntry("tail-padding", "name", metadataTime + 1_000, { text: "m".repeat(20_000) }),
		]);

		const session = await listedSession(filePath);
		expect(session.modified.getTime()).toBe(activityTime);
		expect(session.name).toBe("Tail Name");
	});

	it("falls back to file mtime rather than an ancient head timestamp when the newest record exceeds the scan budget", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-tail-budget-"));
		const filePath = join(dir, "session.jsonl");
		const oldTime = Date.UTC(2026, 0, 1, 0, 0, 0);
		const mtime = new Date(Date.UTC(2026, 0, 4, 0, 0, 0));

		writeJsonl(filePath, [
			createHeader(),
			assistantMessageEntry("old", null, oldTime, oldTime, "old"),
			assistantMessageEntry("huge", "old", mtime.getTime(), mtime.getTime(), "x".repeat(1_100_000)),
		]);
		utimesSync(filePath, mtime, mtime);
		const actualMtime = statSync(filePath).mtime.getTime();

		const session = await listedSession(filePath);
		expect(session.modified.getTime()).toBe(actualMtime);
		expect(session.modified.getTime()).not.toBe(oldTime);
	});
});
