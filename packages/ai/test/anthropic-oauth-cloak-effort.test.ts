import { describe, expect, it } from "vitest";
import { ensureDefaultEffort } from "../src/providers/anthropic-oauth-cloak.js";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";

function baseParams(): MessageCreateParamsStreaming {
	return {
		model: "claude-sonnet-4-20250514",
		max_tokens: 1024,
		stream: true,
		messages: [{ role: "user", content: "hi" }],
	};
}

describe("ensureDefaultEffort", () => {
	it("injects output_config.effort='medium' when thinking.type='adaptive' and no effort is set", () => {
		const params = baseParams();
		(params as any).thinking = { type: "adaptive" };
		ensureDefaultEffort(params, "medium");
		expect((params as any).output_config).toEqual({ effort: "medium" });
	});

	it("does not overwrite an existing output_config.effort", () => {
		const params = baseParams();
		(params as any).thinking = { type: "adaptive" };
		(params as any).output_config = { effort: "low" };
		ensureDefaultEffort(params, "medium");
		expect((params as any).output_config).toEqual({ effort: "low" });
	});

	it("does nothing when thinking is absent", () => {
		const params = baseParams();
		ensureDefaultEffort(params, "medium");
		expect((params as any).output_config).toBeUndefined();
	});

	it("does nothing when thinking.type is not 'adaptive' (budget-based)", () => {
		const params = baseParams();
		(params as any).thinking = { type: "enabled", budget_tokens: 2048 };
		ensureDefaultEffort(params, "medium");
		expect((params as any).output_config).toBeUndefined();
	});

	it("does nothing when thinking.type='disabled'", () => {
		const params = baseParams();
		(params as any).thinking = { type: "disabled" };
		ensureDefaultEffort(params, "medium");
		expect((params as any).output_config).toBeUndefined();
	});
});
