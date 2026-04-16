import { describe, expect, it } from "vitest";
import {
	CLAUDE_CCH_SEED,
	signAnthropicMessagesBody,
	xxHash64,
} from "../src/providers/anthropic-oauth-cloak.js";

function extractCch(body: string): string | undefined {
	const parsed = JSON.parse(body) as { system?: Array<{ text?: string }> };
	const text = parsed.system?.[0]?.text;
	return text?.match(/cch=([0-9a-f]{5});/)?.[1];
}

describe("signAnthropicMessagesBody", () => {
	it("returns body unchanged if system[0] lacks a billing header", () => {
		const body = JSON.stringify({ system: [{ type: "text", text: "some plain prompt" }], messages: [] });
		expect(signAnthropicMessagesBody(body)).toBe(body);
	});

	it("returns body unchanged if billing header has no cch field", () => {
		const body = JSON.stringify({
			system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.108.abc; cc_entrypoint=cli;" }],
			messages: [],
		});
		expect(signAnthropicMessagesBody(body)).toBe(body);
	});

	it("re-signs the cch deterministically", () => {
		const body = JSON.stringify({
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.108.abc; cc_entrypoint=cli; cch=00000;",
				},
				{ type: "text", text: "You are Claude Code." },
			],
			messages: [{ role: "user", content: "hi" }],
		});
		const signed1 = signAnthropicMessagesBody(body);
		const signed2 = signAnthropicMessagesBody(body);
		expect(signed1).toBe(signed2);
		expect(extractCch(signed1)).toMatch(/^[0-9a-f]{5}$/);
	});

	it("produces an xxhash64-derived cch (5 hex chars, low 20 bits)", () => {
		const body = JSON.stringify({
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.108.abc; cc_entrypoint=cli; cch=12345;",
				},
			],
			messages: [],
		});

		const signed = signAnthropicMessagesBody(body);
		const cch = extractCch(signed);
		expect(cch).toBeDefined();

		// Reproduce the algorithm manually: replace cch with 00000, serialize, hash, take low 20 bits.
		const unsignedBody = body.replace(/cch=[0-9a-f]{5};/, "cch=00000;");
		const h = xxHash64(new TextEncoder().encode(unsignedBody), CLAUDE_CCH_SEED);
		const expected = (h & 0xfffffn).toString(16).padStart(5, "0");
		expect(cch).toBe(expected);
	});

	it("changes cch when the body content changes", () => {
		const baseBody = (msg: string) =>
			JSON.stringify({
				system: [
					{
						type: "text",
						text: "x-anthropic-billing-header: cc_version=2.1.108.abc; cc_entrypoint=cli; cch=00000;",
					},
				],
				messages: [{ role: "user", content: msg }],
			});

		const cchA = extractCch(signAnthropicMessagesBody(baseBody("hello")));
		const cchB = extractCch(signAnthropicMessagesBody(baseBody("world")));
		expect(cchA).not.toBe(cchB);
	});

	it("gracefully handles malformed JSON by returning input unchanged", () => {
		const body = "{ not json";
		expect(signAnthropicMessagesBody(body)).toBe(body);
	});
});
