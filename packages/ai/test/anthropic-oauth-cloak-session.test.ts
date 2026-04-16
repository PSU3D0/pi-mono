import { afterEach, describe, expect, it } from "vitest";
import { _resetSessionIdCache, cachedSessionId } from "../src/providers/anthropic-oauth-cloak.js";

describe("cachedSessionId", () => {
	afterEach(() => {
		_resetSessionIdCache();
	});

	it("returns a UUID", () => {
		const id = cachedSessionId("sk-ant-oat01-example");
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it("returns the same id for the same apiKey on subsequent calls", () => {
		const a = cachedSessionId("sk-ant-oat01-alpha");
		const b = cachedSessionId("sk-ant-oat01-alpha");
		expect(a).toBe(b);
	});

	it("returns different ids for different apiKeys", () => {
		const a = cachedSessionId("sk-ant-oat01-alpha");
		const b = cachedSessionId("sk-ant-oat01-beta");
		expect(a).not.toBe(b);
	});

	it("returns a fresh UUID every time when apiKey is empty", () => {
		const a = cachedSessionId("");
		const b = cachedSessionId("");
		expect(a).not.toBe(b);
	});
});
