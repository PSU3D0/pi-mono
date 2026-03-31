import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { getCapabilities, getImageDimensions, imageFallback } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../../utils/shell.js";
import { expandPath } from "./path-utils.js";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: { fg: (name: any, text: string) => string }): string {
	return theme.fg("error", "[invalid arg]");
}

/**
 * Wrap display text in an OSC 8 hyperlink pointing to a file:// URI.
 * If the raw path can't be resolved to an absolute path, returns displayText unchanged.
 *
 * @param displayText - The already-styled text to wrap (may contain ANSI codes)
 * @param rawPath - The original file path argument (may be relative or use ~)
 * @param cwd - Working directory for resolving relative paths
 * @returns displayText wrapped in OSC 8 open/close sequences
 */
export function fileHyperlink(displayText: string, rawPath: string, cwd: string): string {
	try {
		const expanded = expandPath(rawPath);
		const absolutePath = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
		const encodedPath = encodeURI(absolutePath).replace(/#/g, "%23").replace(/\?/g, "%3F");
		return `\x1b]8;;file://${encodedPath}\x07${displayText}\x1b]8;;\x07`;
	} catch {
		return displayText;
	}
}
