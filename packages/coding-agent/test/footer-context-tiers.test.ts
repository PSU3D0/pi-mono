import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

const standardTier = { id: "standard", name: "Standard", contextWindow: 272000, costMultiplier: 1, default: true };
const extendedTier = {
	id: "extended",
	name: "Extended 1M",
	contextWindow: 1050000,
	cost: { input: 5, output: 22.5, cacheRead: 0.5 },
};

describe("FooterComponent context tiers", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows token usage plus latent extended-tier headroom for auto policy", () => {
		const session = {
			state: {
				model: {
					id: "gpt-5.4",
					provider: "openai-codex",
					reasoning: true,
					cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
				},
				thinkingLevel: "high",
			},
			sessionManager: {
				getEntries: () => [],
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({
				tokens: 240000,
				contextWindow: 272000,
				percent: 88.3,
				policy: "auto",
				activeTier: {
					id: "standard",
					name: "Standard",
					contextWindow: 272000,
					costMultiplier: 1,
				},
				availableTiers: [standardTier, extendedTier],
			}),
			modelRegistry: {
				isUsingOAuth: () => true,
			},
		} as unknown as AgentSession;

		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(140).map(stripAnsi);

		expect(lines[1]).toContain("240k/272k→1.1M ↑x2 ↓x1.5 (88.3%) auto compact");
		expect(lines[1]).toContain("gpt-5.4 • high");
	});

	it("keeps default policy display compact", () => {
		const session = {
			state: {
				model: {
					id: "gpt-5.4",
					provider: "openai-codex",
					reasoning: true,
					cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
				},
				thinkingLevel: "high",
			},
			sessionManager: {
				getEntries: () => [],
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({
				tokens: 240000,
				contextWindow: 272000,
				percent: 88.3,
				policy: "default",
				activeTier: {
					id: "standard",
					name: "Standard",
					contextWindow: 272000,
					costMultiplier: 1,
				},
				availableTiers: [standardTier, extendedTier],
			}),
			modelRegistry: {
				isUsingOAuth: () => true,
			},
		} as unknown as AgentSession;

		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(140).map(stripAnsi);

		expect(lines[1]).toContain("240k/272k (88.3%) default compact");
		expect(lines[1]).not.toContain("→");
		expect(lines[1]).not.toContain("↑x2");
	});

	it("shows max policy usage against the active max tier", () => {
		const session = {
			state: {
				model: {
					id: "gpt-5.4",
					provider: "openai-codex",
					reasoning: true,
					cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
				},
				thinkingLevel: "high",
			},
			sessionManager: {
				getEntries: () => [],
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({
				tokens: 501000,
				contextWindow: 1050000,
				percent: 47.7,
				policy: "max",
				activeTier: extendedTier,
				availableTiers: [standardTier, extendedTier],
			}),
			modelRegistry: {
				isUsingOAuth: () => true,
			},
		} as unknown as AgentSession;

		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(140).map(stripAnsi);

		expect(lines[1]).toContain("501k/1.1M ↑x2 ↓x1.5 (47.7%) max compact");
		expect(lines[1]).not.toContain("→");
	});
});
