import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const compactMock = vi.fn(async (preparation: any) => ({
	summary: "compacted",
	firstKeptEntryId: preparation.firstKeptEntryId,
	tokensBefore: preparation.tokensBefore,
	details: {},
}));

const prepareCompactionMock = vi.fn(() => createPreparation());

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: () => 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: compactMock,
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: -1 }),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: prepareCompactionMock,
	shouldCompact: () => false,
}));

function createPreparation() {
	const messagesToSummarize: AgentMessage[] = [
		{ role: "user", content: "summarize this", timestamp: 1 } as AgentMessage,
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "X".repeat(5000) }],
			isError: false,
			timestamp: 2,
		} as AgentMessage,
	];

	const turnPrefixMessages: AgentMessage[] = [
		{
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "bash",
			content: [{ type: "text", text: "Y".repeat(4000) }],
			isError: false,
			timestamp: 3,
		} as AgentMessage,
	];

	return {
		firstKeptEntryId: "entry-1",
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: false,
		tokensBefore: 12345,
		previousSummary: undefined,
		fileOps: { read: new Set<string>(), edited: new Set<string>() },
		settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
	};
}

describe("AgentSession compaction applies context transforms", () => {
	let session: AgentSession;
	let tempDir: string;
	let emitContextSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-context-transform-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		emitContextSpy = vi.fn(async (messages: AgentMessage[]) =>
			messages.map((message) => {
				if (message.role !== "toolResult") return message;
				return {
					...message,
					content: [{ type: "text", text: "[pruned-by-context-hook]" }],
				} as AgentMessage;
			}),
		);

		(session as unknown as { _extensionRunner: any })._extensionRunner = {
			hasHandlers: (event: string) => event === "context",
			emitContext: emitContextSpy,
			emit: vi.fn(async () => undefined),
		};

		compactMock.mockClear();
		prepareCompactionMock.mockClear();
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("manual compaction runs context hooks before summarize request", async () => {
		await session.compact();

		expect(emitContextSpy).toHaveBeenCalledTimes(2);
		expect(compactMock).toHaveBeenCalledTimes(1);

		const preparationArg = compactMock.mock.calls[0][0];
		expect(preparationArg.messagesToSummarize[1].content[0].text).toBe("[pruned-by-context-hook]");
		expect(preparationArg.turnPrefixMessages[0].content[0].text).toBe("[pruned-by-context-hook]");
	});

	it("auto-compaction runs context hooks before summarize request", async () => {
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);

		expect(emitContextSpy).toHaveBeenCalledTimes(2);
		expect(compactMock).toHaveBeenCalledTimes(1);

		const preparationArg = compactMock.mock.calls[0][0];
		expect(preparationArg.messagesToSummarize[1].content[0].text).toBe("[pruned-by-context-hook]");
		expect(preparationArg.turnPrefixMessages[0].content[0].text).toBe("[pruned-by-context-hook]");
	});
});
