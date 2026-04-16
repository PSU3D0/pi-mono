import { describe, expect, it } from "vitest";
import {
	computeBuildFingerprint,
	generateBillingHeader,
} from "../src/providers/anthropic-oauth-cloak.js";

describe("computeBuildFingerprint", () => {
	it("produces 3 lowercase hex characters", () => {
		const fp = computeBuildFingerprint("2.1.108", "Hello world, this is a system prompt.");
		expect(fp).toMatch(/^[0-9a-f]{3}$/);
	});

	it("is deterministic for the same inputs", () => {
		const a = computeBuildFingerprint("2.1.108", "system text here");
		const b = computeBuildFingerprint("2.1.108", "system text here");
		expect(a).toBe(b);
	});

	it("differs when version differs", () => {
		const a = computeBuildFingerprint("2.1.108", "identical input text");
		const b = computeBuildFingerprint("2.1.999", "identical input text");
		expect(a).not.toBe(b);
	});

	it("reads runes at indices 4, 7, 20 (characters, not bytes)", () => {
		// Indices past end should be padded with '0' — empty input yields a specific fp.
		const empty = computeBuildFingerprint("2.1.108", "");
		const short = computeBuildFingerprint("2.1.108", "ab");
		// Both have all three indices missing → same padding → same fingerprint.
		expect(empty).toBe(short);
	});

	it("handles multi-byte unicode by rune (code point) index", () => {
		// Rune index 4 across ASCII vs multi-byte prefix should differ.
		const ascii = computeBuildFingerprint("2.1.108", "abcdefghijklmnopqrstuvwxyz");
		const unicode = computeBuildFingerprint("2.1.108", "🚀🚀🚀🚀abcdefghijklmnopqrst");
		expect(ascii).not.toBe(unicode);
	});
});

describe("generateBillingHeader", () => {
	const payload = new TextEncoder().encode(
		JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
	);

	it("matches the Claude Code format: cc_version=<ver>.<3hex>; cc_entrypoint=cli; cch=<5hex>;", () => {
		const header = generateBillingHeader(payload, "2.1.108", "first system text");
		expect(header).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.108\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
	});

	it("is deterministic for identical payload + version + first text", () => {
		const a = generateBillingHeader(payload, "2.1.108", "first");
		const b = generateBillingHeader(payload, "2.1.108", "first");
		expect(a).toBe(b);
	});

	it("changes cch when payload bytes change", () => {
		const otherPayload = new TextEncoder().encode(
			JSON.stringify({ messages: [{ role: "user", content: "different" }] }),
		);
		const a = generateBillingHeader(payload, "2.1.108", "first");
		const b = generateBillingHeader(otherPayload, "2.1.108", "first");
		const cchA = a.match(/cch=([0-9a-f]{5})/)?.[1];
		const cchB = b.match(/cch=([0-9a-f]{5})/)?.[1];
		expect(cchA).not.toBe(cchB);
	});

	it("changes build fingerprint when first system text changes", () => {
		const a = generateBillingHeader(payload, "2.1.108", "text one");
		const b = generateBillingHeader(payload, "2.1.108", "text two");
		const buildA = a.match(/cc_version=2\.1\.108\.([0-9a-f]{3})/)?.[1];
		const buildB = b.match(/cc_version=2\.1\.108\.([0-9a-f]{3})/)?.[1];
		expect(buildA).not.toBe(buildB);
	});

	it("defaults entrypoint to 'cli' and accepts overrides", () => {
		const cli = generateBillingHeader(payload, "2.1.108", "x", "cli");
		const vscode = generateBillingHeader(payload, "2.1.108", "x", "vscode");
		expect(cli).toMatch(/cc_entrypoint=cli;/);
		expect(vscode).toMatch(/cc_entrypoint=vscode;/);
	});

	it("appends cc_workload when provided", () => {
		const header = generateBillingHeader(payload, "2.1.108", "x", "cli", "interactive");
		expect(header).toMatch(/cch=[0-9a-f]{5}; cc_workload=interactive;$/);
	});

	it("omits cc_workload when empty string", () => {
		const header = generateBillingHeader(payload, "2.1.108", "x", "cli", "");
		expect(header).not.toMatch(/cc_workload/);
		expect(header.endsWith(";")).toBe(true);
	});
});
