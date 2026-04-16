import { describe, expect, it } from "vitest";
import { xxHash64 } from "../src/providers/anthropic-oauth-cloak.js";

// Reference vectors from https://github.com/Cyan4973/xxHash/blob/dev/cli/xxhsum.c
// (`xxhsum` command-line output, or cross-checked against github.com/pierrec/xxHash).
describe("xxHash64", () => {
	const encoder = new TextEncoder();

	it("matches the canonical empty-input vector (seed=0) = 0xEF46DB3751D8E999", () => {
		const h = xxHash64(new Uint8Array(0), 0n);
		expect(h).toBe(0xef46db3751d8e999n);
	});

	it("matches the canonical 'a' (seed=0) = 0xD24EC4F1A98C6E5B", () => {
		const h = xxHash64(encoder.encode("a"), 0n);
		expect(h).toBe(0xd24ec4f1a98c6e5bn);
	});

	it("matches the 'heiagerag' (seed=0, 9 bytes) vector", () => {
		// Verified against github.com/pierrec/xxHash — the same lib the fork uses.
		const h = xxHash64(encoder.encode("heiagerag"), 0n);
		expect(h).toBe(0x8c52a7bddc630b6dn);
	});

	it("matches the canonical 'Nobody inspects the spammish repetition' (seed=0) vector", () => {
		// 39 byte input hits the >=32 branch. Reference vector well-known.
		const h = xxHash64(
			encoder.encode("Nobody inspects the spammish repetition"),
			0n,
		);
		expect(h).toBe(0xfbcea83c8a378bf1n);
	});

	it("uses the seed parameter", () => {
		const msg = encoder.encode("hello world");
		const a = xxHash64(msg, 0n);
		const b = xxHash64(msg, 1n);
		expect(a).not.toBe(b);
	});

	it("is deterministic", () => {
		const msg = encoder.encode("pi-mono test input");
		const a = xxHash64(msg, 0x6e52736ac806831en);
		const b = xxHash64(msg, 0x6e52736ac806831en);
		expect(a).toBe(b);
	});

	it("handles inputs longer than 32 bytes correctly (4-lane path)", () => {
		// 200 bytes of 'a' exercises the long-input 4-accumulator path.
		// Verified against github.com/pierrec/xxHash.
		const msg = encoder.encode("a".repeat(200));
		const h = xxHash64(msg, 0n);
		expect(h).toBe(0x942e9189f34eebben);
	});

	it("matches the pi-mono test vector with the fork's claude CCH seed", () => {
		// seed = 0x6E52736AC806831E (claudeCCHSeed in claude_signing.go)
		const h = xxHash64(
			new TextEncoder().encode("pi-mono test input"),
			0x6e52736ac806831en,
		);
		expect(h).toBe(0x7729294b2ce87833n);
	});
});
