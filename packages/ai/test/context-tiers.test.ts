import { describe, expect, it } from "vitest";
import {
	calculateCost,
	getContextTierPriceIndicator,
	getContextTiers,
	getDefaultContextTier,
	getMaxContextTier,
	getModel,
	resolveContextTier,
} from "../src/models.js";
import type { Model, Usage } from "../src/types.js";

describe("context tiers", () => {
	it("provides a default single tier for models without explicit tiers", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const tiers = getContextTiers(model);

		expect(tiers).toHaveLength(1);
		expect(tiers[0]).toMatchObject({
			id: "default",
			name: "Default",
			contextWindow: model.contextWindow,
			costMultiplier: 1,
			default: true,
		});
	});

	it("resolves explicit default and max tiers", () => {
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
			contextWindow: 272000,
			contextTiers: [
				{ id: "standard", name: "Standard", contextWindow: 272000, default: true },
				{
					id: "extended",
					name: "Extended 1M",
					contextWindow: 1050000,
					cost: { input: 5, output: 22.5, cacheRead: 0.5 },
				},
			],
			maxTokens: 128000,
		};

		expect(getDefaultContextTier(model).id).toBe("standard");
		expect(getMaxContextTier(model).id).toBe("extended");
		expect(resolveContextTier(model, "default", 500000).id).toBe("standard");
		expect(resolveContextTier(model, "max", 1000).id).toBe("extended");
		expect(resolveContextTier(model, "auto", 200000).id).toBe("standard");
		expect(resolveContextTier(model, "auto", 300000).id).toBe("extended");
	});

	it("applies exact tier pricing once prompt usage crosses into a higher tier", () => {
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
			contextWindow: 272000,
			contextTiers: [
				{ id: "standard", name: "Standard", contextWindow: 272000, default: true },
				{
					id: "extended",
					name: "Extended 1M",
					contextWindow: 1050000,
					cost: { input: 5, output: 22.5, cacheRead: 0.5 },
				},
			],
			maxTokens: 128000,
		};

		const standardUsage: Usage = {
			input: 200000,
			output: 10000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, standardUsage);
		expect(standardUsage.cost.input).toBeCloseTo(0.5);
		expect(standardUsage.cost.output).toBeCloseTo(0.15);
		expect(standardUsage.cost.total).toBeCloseTo(0.65);

		const extendedUsage: Usage = {
			input: 300000,
			output: 10000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 310000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, extendedUsage);
		expect(extendedUsage.cost.input).toBeCloseTo(1.5);
		expect(extendedUsage.cost.output).toBeCloseTo(0.225);
		expect(extendedUsage.cost.total).toBeCloseTo(1.725);
	});

	it("formats non-uniform tier pricing for UI display", () => {
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
			contextWindow: 272000,
			contextTiers: [
				{ id: "standard", name: "Standard", contextWindow: 272000, default: true },
				{
					id: "extended",
					name: "Extended 1M",
					contextWindow: 1050000,
					cost: { input: 5, output: 22.5, cacheRead: 0.5 },
				},
			],
			maxTokens: 128000,
		};

		expect(getContextTierPriceIndicator(model, model.contextTiers![1]!)).toBe("↑x2 ↓x1.5");
	});
});
