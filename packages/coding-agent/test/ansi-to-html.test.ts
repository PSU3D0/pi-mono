import { describe, expect, it } from "vitest";
import { ansiToHtml } from "../src/core/export-html/ansi-to-html.js";

describe("ansiToHtml", () => {
	describe("OSC 8 hyperlinks", () => {
		it("should convert OSC 8 hyperlink to HTML anchor tag", () => {
			const url = "file:///home/user/test.ts";
			const text = `\x1b]8;;${url}\x07click here\x1b]8;;\x07`;

			const html = ansiToHtml(text);

			expect(html).toContain(`<a href="${url}"`);
			expect(html).toContain("click here");
			expect(html).toContain("</a>");
			expect(html).toContain('target="_blank"');
			expect(html).toContain('rel="noopener"');
		});

		it("should handle OSC 8 with SGR styling inside", () => {
			const url = "file:///tmp/test.ts";
			const text = `\x1b[36m\x1b]8;;${url}\x07styled link\x1b]8;;\x07\x1b[0m`;

			const html = ansiToHtml(text);

			expect(html).toContain(`<a href="${url}"`);
			expect(html).toContain("<span");
			expect(html).toContain("styled link");
		});

		it("should handle OSC 8 terminated with ST (ESC backslash)", () => {
			const url = "file:///tmp/test.ts";
			const text = `\x1b]8;;${url}\x1b\\click\x1b]8;;\x1b\\`;

			const html = ansiToHtml(text);

			expect(html).toContain(`<a href="${url}"`);
			expect(html).toContain("click");
			expect(html).toContain("</a>");
		});

		it("should escape HTML special chars in URL", () => {
			const url = "file:///tmp/test&file.ts";
			const text = `\x1b]8;;${url}\x07link\x1b]8;;\x07`;

			const html = ansiToHtml(text);

			expect(html).toContain("&amp;");
		});

		it("should handle text with no escape sequences", () => {
			expect(ansiToHtml("plain text")).toBe("plain text");
		});

		it("should handle mixed SGR and OSC 8 sequences", () => {
			const url = "file:///tmp/f.ts";
			const text = `\x1b[1mbold\x1b[0m then \x1b]8;;${url}\x07link\x1b]8;;\x07 then plain`;

			const html = ansiToHtml(text);

			expect(html).toContain("<span");
			expect(html).toContain("bold");
			expect(html).toContain(`<a href="${url}"`);
			expect(html).toContain("link");
			expect(html).toContain(" then plain");
		});
	});
});
