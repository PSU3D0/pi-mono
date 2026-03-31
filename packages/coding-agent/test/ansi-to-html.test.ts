import assert from "node:assert";
import { describe, it } from "node:test";
import { ansiToHtml } from "../src/core/export-html/ansi-to-html.js";

describe("ansiToHtml", () => {
	describe("OSC 8 hyperlinks", () => {
		it("should convert OSC 8 hyperlink to HTML anchor tag", () => {
			const url = "file:///home/user/test.ts";
			const text = `\x1b]8;;${url}\x07click here\x1b]8;;\x07`;

			const html = ansiToHtml(text);

			assert.ok(html.includes(`<a href="${url}"`), "should contain anchor tag with URL");
			assert.ok(html.includes("click here"), "should contain link text");
			assert.ok(html.includes("</a>"), "should close anchor tag");
			assert.ok(html.includes('target="_blank"'), "should open in new tab");
			assert.ok(html.includes('rel="noopener"'), "should have noopener");
		});

		it("should handle OSC 8 with SGR styling inside", () => {
			const url = "file:///tmp/test.ts";
			const text = `\x1b[36m\x1b]8;;${url}\x07styled link\x1b]8;;\x07\x1b[0m`;

			const html = ansiToHtml(text);

			assert.ok(html.includes(`<a href="${url}"`), "should have anchor tag");
			assert.ok(html.includes("<span"), "should have styled span");
			assert.ok(html.includes("styled link"), "should have link text");
		});

		it("should handle OSC 8 terminated with ST (ESC backslash)", () => {
			const url = "file:///tmp/test.ts";
			const text = `\x1b]8;;${url}\x1b\\click\x1b]8;;\x1b\\`;

			const html = ansiToHtml(text);

			assert.ok(html.includes(`<a href="${url}"`), "should handle ST-terminated sequences");
			assert.ok(html.includes("click"), "should contain link text");
			assert.ok(html.includes("</a>"), "should close anchor tag");
		});

		it("should escape HTML special chars in URL", () => {
			const url = "file:///tmp/test&file.ts";
			const text = `\x1b]8;;${url}\x07link\x1b]8;;\x07`;

			const html = ansiToHtml(text);

			assert.ok(html.includes("&amp;"), "should escape ampersand in URL");
		});

		it("should handle text with no escape sequences", () => {
			const html = ansiToHtml("plain text");
			assert.strictEqual(html, "plain text");
		});

		it("should handle mixed SGR and OSC 8 sequences", () => {
			const url = "file:///tmp/f.ts";
			const text = `\x1b[1mbold\x1b[0m then \x1b]8;;${url}\x07link\x1b]8;;\x07 then plain`;

			const html = ansiToHtml(text);

			assert.ok(html.includes("<span"), "should have bold span");
			assert.ok(html.includes("bold"), "should have bold text");
			assert.ok(html.includes(`<a href="${url}"`), "should have anchor");
			assert.ok(html.includes("link"), "should have link text");
			assert.ok(html.includes(" then plain"), "should have trailing plain text");
		});
	});
});
