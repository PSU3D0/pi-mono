import { createHash, randomUUID } from "node:crypto";
import {
	buildUsingToolsSection,
	CLAUDE_CODE_ACTIONS,
	CLAUDE_CODE_DOING_TASKS,
	CLAUDE_CODE_INTRO,
	CLAUDE_CODE_OUTPUT_EFFICIENCY,
	CLAUDE_CODE_SYSTEM,
	CLAUDE_CODE_TONE_AND_STYLE,
	resolveTaskToolName,
	sanitizeForwardedSystemPrompt,
} from "./anthropic-oauth-prompts.js";
import type { Message, Tool } from "../types.js";

// Claude Code v2.1.108 device profile baseline. When OAuth-cloaking, we emit
// these values regardless of the real host's OS/arch so Anthropic's fingerprint
// check treats us as the official CLI.
export const CLAUDE_CODE_VERSION = "2.1.108";
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`;
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = "0.81.0";
export const CLAUDE_CODE_STAINLESS_RUNTIME_VERSION = "v24.3.0";
export const CLAUDE_CODE_STAINLESS_OS = "MacOS";
export const CLAUDE_CODE_STAINLESS_ARCH = "arm64";

const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20] as const;

/**
 * Compute the 3-char build fingerprint that Claude Code embeds in `cc_version`.
 * Algorithm: sha256(salt + messageText[4] + messageText[7] + messageText[20] + version).slice(0,3)
 *
 * Indices that fall past the end of the rune sequence are replaced with '0'.
 * Operates on Unicode code points (runes), not UTF-8 bytes — this matches the
 * Go reference which iterates `[]rune(messageText)`.
 */
export function computeBuildFingerprint(version: string, messageText: string): string {
	const runes = [...messageText];
	let picked = "";
	for (const idx of FINGERPRINT_INDICES) {
		picked += idx < runes.length ? runes[idx] : "0";
	}
	return createHash("sha256").update(FINGERPRINT_SALT + picked + version).digest("hex").slice(0, 3);
}

/**
 * Build the `x-anthropic-billing-header` text block that real Claude Code
 * prepends as `system[0]`.
 *
 * Format: `x-anthropic-billing-header: cc_version=<ver>.<3hex>; cc_entrypoint=<ep>; cch=<5hex>;[ cc_workload=<wl>;]`
 *
 * `cch` is the first 5 hex chars of sha256(payload) — the legacy mode from the
 * fork. CLIProxyAPIPlus also supports an experimental xxhash64 mode under an
 * opt-in config flag, but the server accepts both; we use the sha256 mode
 * since it has no external dependency.
 */
export function generateBillingHeader(
	payload: Uint8Array,
	version: string,
	firstSystemText: string,
	entrypoint: string = "cli",
	workload?: string,
): string {
	const ep = entrypoint.length > 0 ? entrypoint : "cli";
	const buildFp = computeBuildFingerprint(version, firstSystemText);
	const cch = createHash("sha256").update(payload).digest("hex").slice(0, 5);
	const workloadSuffix = workload && workload.length > 0 ? ` cc_workload=${workload};` : "";
	return `x-anthropic-billing-header: cc_version=${version}.${buildFp}; cc_entrypoint=${ep}; cch=${cch};${workloadSuffix}`;
}

/**
 * Stable session UUID per apiKey, kept alive as long as the key is in use.
 * Refreshes the TTL on every access to mimic a long-running Claude Code
 * session. Not persisted — scoped to this process.
 */
const SESSION_ID_TTL_MS = 60 * 60 * 1000; // 1 hour
const sessionIdCache = new Map<string, { value: string; expiresAt: number }>();

function sessionIdKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex");
}

export function cachedSessionId(apiKey: string): string {
	if (!apiKey) return randomUUID();
	const key = sessionIdKey(apiKey);
	const now = Date.now();
	const existing = sessionIdCache.get(key);
	if (existing && existing.expiresAt > now) {
		existing.expiresAt = now + SESSION_ID_TTL_MS;
		return existing.value;
	}
	const id = randomUUID();
	sessionIdCache.set(key, { value: id, expiresAt: now + SESSION_ID_TTL_MS });
	return id;
}

/** Test-only: clear the session id cache. */
export function _resetSessionIdCache(): void {
	sessionIdCache.clear();
}

// ---------------------------------------------------------------------------
// Opaque tool-alias cloaking.
//
// Real Claude Code's tool roster is public. Any custom/user-defined tool name
// we forward verbatim (e.g. "company_search_api", "lookup_order") is a strong
// signal to Anthropic that the traffic is not first-party. The fork replaces
// custom names with opaque short aliases (t1, t2, …) for the wire payload, and
// reverses them on the response stream. Builtins pass through unchanged.
// ---------------------------------------------------------------------------

/**
 * Full canonical set of Claude Code v2.1.x tool names. If the caller provides
 * a tool whose name case-insensitively matches one of these, we emit it in
 * Claude Code's canonical casing rather than aliasing it — matching the
 * model's training bias (which tends to call "Read" / "Bash" even when the
 * tool list uses different casing) and making the wire fingerprint more
 * Claude-Code-like than opaque aliases would.
 */
export const CLAUDE_CODE_CANONICAL_TOOL_NAMES: readonly string[] = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"TaskCreate",
	"TaskGet",
	"TaskUpdate",
	"TaskList",
	"WebFetch",
	"WebSearch",
];

const CANONICAL_TOOL_LOOKUP = new Map(
	CLAUDE_CODE_CANONICAL_TOOL_NAMES.map((n) => [n.toLowerCase(), n]),
);

/**
 * Tool names that are builtins Anthropic's server recognizes (server-side
 * tools + Claude Code's native tool roster). These pass through without
 * aliasing — they are expected traffic.
 */
export const CLAUDE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
	// Server-side Anthropic builtins
	"web_search",
	"code_execution",
	"text_editor",
	"computer",
	// Claude Code's native tools (canonical casing + common lowercase alias
	// for the Task family, matching the Go fork's registry).
	...CLAUDE_CODE_CANONICAL_TOOL_NAMES,
	"todowrite",
	"taskcreate",
	"taskget",
	"taskupdate",
	"tasklist",
]);

export interface ToolAliasMaps {
	/** original name → opaque alias (apply outbound) */
	forward: Map<string, string>;
	/** opaque alias → original name (apply to inbound stream events) */
	reverse: Map<string, string>;
}

function isServerSideTool(t: unknown): boolean {
	if (!t || typeof t !== "object") return false;
	const maybe = t as { type?: unknown };
	return typeof maybe.type === "string" && maybe.type.length > 0;
}

/**
 * Pattern for a real Claude Code MCP tool name: `mcp__<server>__<tool>`.
 * Both segments allow letters, digits, underscore, and hyphen (matching real
 * MCP server/tool names seen in the wild: `mcp__chrome-devtools__nav`,
 * `mcp__openaiDeveloperDocs__search_openai_docs`). Anthropic accepts these
 * verbatim on the OAuth pathway — the proxy's sanitization logic in
 * CLIProxyAPIPlus explicitly preserves the `mcp__` prefix.
 */
const MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

/**
 * Classify a tool name:
 *   - "builtin": exact match to a Claude Code / server-side builtin name.
 *     Pass-through — this is expected CC traffic.
 *   - "mcp": matches the `mcp__server__tool` pattern. A user-configured MCP
 *     tool. Pass-through exactly like a builtin.
 *   - "canonical": case-insensitive match to a Claude Code tool (e.g. caller
 *     registered `bash`; CC's canonical is `Bash`). Emit canonical on the
 *     wire; reverse to the caller's original casing in stream events.
 *   - "custom": none of the above — subject to alias cloaking.
 */
export type ToolClassification =
	| { kind: "builtin" }
	| { kind: "mcp" }
	| { kind: "canonical"; canonical: string }
	| { kind: "custom" };

export function classifyToolName(name: string): ToolClassification {
	if (CLAUDE_BUILTIN_TOOL_NAMES.has(name)) return { kind: "builtin" };
	if (MCP_TOOL_PATTERN.test(name)) return { kind: "mcp" };
	const canonical = CANONICAL_TOOL_LOOKUP.get(name.toLowerCase());
	if (canonical) return { kind: "canonical", canonical };
	return { kind: "custom" };
}

function collectCustomToolNames(
	tools: readonly Tool[] | undefined,
	messages: readonly Message[] | undefined,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (name: unknown): void => {
		if (typeof name !== "string" || name.length === 0) return;
		if (classifyToolName(name).kind !== "custom") return;
		if (seen.has(name)) return;
		seen.add(name);
		out.push(name);
	};

	if (tools) {
		for (const t of tools) {
			if (isServerSideTool(t)) continue;
			add(t.name);
		}
	}

	if (messages) {
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					add(block.name);
				}
			}
		}
	}

	return out;
}

/**
 * Walk the tools list + prior assistant tool_use messages and, for each
 * case-insensitive match against a Claude Code canonical tool name, record a
 * forward rename to the canonical casing. The reverse map inverts so stream
 * events restore the caller's original casing.
 */
function collectCanonicalRenames(
	tools: readonly Tool[] | undefined,
	messages: readonly Message[] | undefined,
): Map<string, string> {
	const out = new Map<string, string>();
	const consider = (name: unknown): void => {
		if (typeof name !== "string" || name.length === 0) return;
		if (out.has(name)) return;
		const c = classifyToolName(name);
		if (c.kind === "canonical" && c.canonical !== name) {
			out.set(name, c.canonical);
		}
	};
	if (tools) {
		for (const t of tools) {
			if (isServerSideTool(t)) continue;
			consider(t.name);
		}
	}
	if (messages) {
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			for (const block of msg.content) {
				if (block.type === "toolCall") consider(block.name);
			}
		}
	}
	return out;
}

/**
 * Options for building tool-alias maps.
 *
 * `scheme` picks the alias format for non-builtin, non-canonical, non-MCP
 * (i.e. truly custom) tools:
 *   - `"short"`        — opaque `t1`, `t2`, … (compact but atypical for CC)
 *   - `"mcp"`          — `mcp__<server>__<origName>` with the caller's real
 *                        tool name preserved (sanitized for the MCP pattern).
 *                        Best model priors and cache stability; looks like a
 *                        genuine user-configured MCP server. Default.
 *   - `"mcp-opaque"`   — `mcp__<server>__t1`, … fully opaque inside the MCP
 *                        wrapper. Use when the real tool names themselves
 *                        would reveal caller identity or be awkward to log.
 *
 * `mcpServerName` chooses the middle segment when scheme starts with `mcp`.
 * Default `"local"` — generic word, doesn't identify the caller.
 */
export interface BuildToolAliasesOptions {
	scheme?: "short" | "mcp" | "mcp-opaque";
	mcpServerName?: string;
}

/** Tool-name segment of an MCP tool name: A-Z, a-z, 0-9, underscore, hyphen. */
const MCP_NAME_SAFE_CHARS = /[^A-Za-z0-9_-]/g;

/**
 * Sanitize a caller-provided tool name into a form safe for the tool segment
 * of an MCP tool name (`mcp__<server>__<sanitized>`). Replaces disallowed
 * characters with `_`. Returns an empty string if the result would be empty.
 *
 * Length check is the caller's responsibility — the alias builder trims to
 * fit the 64-char wire limit including prefix.
 */
function sanitizeMcpToolSegment(name: string): string {
	if (typeof name !== "string" || name.length === 0) return "";
	const sanitized = name.replace(MCP_NAME_SAFE_CHARS, "_");
	// Guard against all-underscore results that provide no info.
	if (/^_+$/.test(sanitized)) return "";
	return sanitized;
}

/**
 * Build forward + reverse alias maps.
 *
 * Three cloaking strategies are applied per tool:
 *   (1) Canonical rename — "read" → "Read", "bash" → "Bash". Triggers when
 *       the user's tool name case-insensitively matches a Claude Code tool.
 *   (2) MCP pass-through — tool names already matching `mcp__server__tool`
 *       are treated like builtins; no rename, no alias. User-configured MCP
 *       tools and tools from pi's MCP adapter flow through unchanged.
 *   (3) Alias cloaking — truly custom tools get either `t1..tN`
 *       (scheme=short), `mcp__<server>__<sanitized-name>` (scheme=mcp,
 *       default), or `mcp__<server>__t1..tN` (scheme=mcp-opaque).
 *
 * Alias indices advance past any candidate that collides with a builtin, a
 * canonical rename target, a user-declared tool name, or a prior alias.
 * Under scheme=mcp, sanitization collisions (two tool names reducing to the
 * same MCP-safe form) fall back to the opaque `tN` variant.
 */
export function buildToolAliases(
	tools: readonly Tool[] | undefined,
	messages: readonly Message[] | undefined,
	options?: BuildToolAliasesOptions,
): ToolAliasMaps {
	const scheme = options?.scheme ?? "short";
	const mcpServerName = options?.mcpServerName ?? "local";
	const aliasPrefix =
		scheme === "mcp" || scheme === "mcp-opaque" ? `mcp__${mcpServerName}__` : "";
	const WIRE_NAME_LIMIT = 64;
	const descriptiveBudget = WIRE_NAME_LIMIT - aliasPrefix.length;

	const forward = new Map<string, string>();
	const reverse = new Map<string, string>();

	// Strategy 1: case-insensitive canonical renames.
	const canonicalRenames = collectCanonicalRenames(tools, messages);
	for (const [original, canonical] of canonicalRenames) {
		forward.set(original, canonical);
		reverse.set(canonical, original);
	}

	// Strategy 3: alias cloaking for custom tools.
	const custom = collectCustomToolNames(tools, messages);
	if (custom.length === 0) return { forward, reverse };

	const taken = new Set<string>(CLAUDE_BUILTIN_TOOL_NAMES);
	for (const [original, canonical] of canonicalRenames) {
		taken.add(original);
		taken.add(canonical);
	}
	for (const name of custom) taken.add(name);
	// Pre-canonical MCP tools from the input pass through — reserve their
	// names so alias candidates can't collide.
	if (tools) {
		for (const t of tools) {
			if (isServerSideTool(t)) continue;
			if (typeof t.name === "string" && classifyToolName(t.name).kind === "mcp") {
				taken.add(t.name);
			}
		}
	}

	let nextIndex = 1;
	const nextOpaque = (): string => {
		while (true) {
			const candidate = `${aliasPrefix}t${nextIndex++}`;
			if (!taken.has(candidate)) {
				taken.add(candidate);
				return candidate;
			}
		}
	};

	for (const name of custom) {
		let alias: string;
		if (scheme === "mcp") {
			// Try descriptive first: mcp__<server>__<sanitized-name>.
			const segment = sanitizeMcpToolSegment(name).slice(0, descriptiveBudget);
			const descriptive = segment.length > 0 ? `${aliasPrefix}${segment}` : "";
			if (descriptive.length > 0 && !taken.has(descriptive)) {
				alias = descriptive;
				taken.add(alias);
			} else {
				// Fall back to opaque — either sanitization produced nothing
				// usable, or two inputs collided on the wire name.
				alias = nextOpaque();
			}
		} else {
			alias = nextOpaque();
		}
		forward.set(name, alias);
		reverse.set(alias, name);
	}

	return { forward, reverse };
}

/** Outbound helper: rewrite `name` to its alias, pass through if none. */
export function resolveAlias(name: string, forward: Map<string, string>): string {
	return forward.get(name) ?? name;
}

/** Inbound helper: rewrite `alias` back to the original name, pass through if unknown. */
export function reverseAlias(alias: string, reverse: Map<string, string>): string {
	return reverse.get(alias) ?? alias;
}

// ---------------------------------------------------------------------------
// Effort injection.
//
// Claude Code sets output_config.effort itself based on user input. For OAuth
// clients that aren't real Claude Code, the server expects an explicit effort
// when thinking is adaptive — otherwise it may refuse. Injecting "medium" as
// a default matches the fork's behavior for non-OpenCode clients.
// ---------------------------------------------------------------------------

type EffortMutable = { thinking?: { type?: string }; output_config?: { effort?: string } };

/**
 * Mutates `params` in-place: when thinking.type === "adaptive" and no
 * output_config.effort is set, assign the default effort. No-op otherwise.
 */
export function ensureDefaultEffort(params: unknown, defaultEffort: string): void {
	const p = params as EffortMutable;
	if (!p || typeof p !== "object") return;
	if (p.thinking?.type !== "adaptive") return;
	if (p.output_config && typeof p.output_config.effort === "string") return;
	p.output_config = { ...(p.output_config ?? {}), effort: defaultEffort };
}

// ---------------------------------------------------------------------------
// xxHash64 — used for the OAuth billing-header content hash (cch).
//
// Reference: https://xxhash.com/ (XXH64, 64-bit little-endian).
// Deterministic; verified against github.com/pierrec/xxHash (the same lib the
// Go fork uses). Implemented in pure TypeScript with BigInt arithmetic so no
// native or wasm dep is required.
// ---------------------------------------------------------------------------

const MASK64 = 0xffff_ffff_ffff_ffffn;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

function mul64(a: bigint, b: bigint): bigint {
	return (a * b) & MASK64;
}

function rotl64(v: bigint, r: number): bigint {
	const s = BigInt(r);
	return (((v << s) | (v >> (64n - s))) & MASK64);
}

function round64(acc: bigint, input: bigint): bigint {
	acc = (acc + mul64(input, PRIME64_2)) & MASK64;
	acc = rotl64(acc, 31);
	return mul64(acc, PRIME64_1);
}

function mergeRound64(acc: bigint, val: bigint): bigint {
	val = round64(0n, val);
	acc = acc ^ val;
	return (mul64(acc, PRIME64_1) + PRIME64_4) & MASK64;
}

function readUint64LE(buf: Uint8Array, offset: number): bigint {
	// Little-endian 8-byte read → BigInt
	let v = 0n;
	for (let i = 7; i >= 0; i--) {
		v = (v << 8n) | BigInt(buf[offset + i]);
	}
	return v;
}

function readUint32LE(buf: Uint8Array, offset: number): bigint {
	return (
		BigInt(buf[offset]) |
		(BigInt(buf[offset + 1]) << 8n) |
		(BigInt(buf[offset + 2]) << 16n) |
		(BigInt(buf[offset + 3]) << 24n)
	);
}

export function xxHash64(input: Uint8Array, seed: bigint): bigint {
	const len = input.length;
	let h64: bigint;
	let offset = 0;

	if (len >= 32) {
		let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
		let v2 = (seed + PRIME64_2) & MASK64;
		let v3 = seed;
		let v4 = (seed - PRIME64_1) & MASK64;

		const limit = len - 32;
		while (offset <= limit) {
			v1 = round64(v1, readUint64LE(input, offset));
			offset += 8;
			v2 = round64(v2, readUint64LE(input, offset));
			offset += 8;
			v3 = round64(v3, readUint64LE(input, offset));
			offset += 8;
			v4 = round64(v4, readUint64LE(input, offset));
			offset += 8;
		}

		h64 =
			(rotl64(v1, 1) +
				rotl64(v2, 7) +
				rotl64(v3, 12) +
				rotl64(v4, 18)) &
			MASK64;
		h64 = mergeRound64(h64, v1);
		h64 = mergeRound64(h64, v2);
		h64 = mergeRound64(h64, v3);
		h64 = mergeRound64(h64, v4);
	} else {
		h64 = (seed + PRIME64_5) & MASK64;
	}

	h64 = (h64 + BigInt(len)) & MASK64;

	while (offset + 8 <= len) {
		const k1 = round64(0n, readUint64LE(input, offset));
		h64 = h64 ^ k1;
		h64 = (mul64(rotl64(h64, 27), PRIME64_1) + PRIME64_4) & MASK64;
		offset += 8;
	}

	if (offset + 4 <= len) {
		h64 = h64 ^ mul64(readUint32LE(input, offset), PRIME64_1);
		h64 = (mul64(rotl64(h64, 23), PRIME64_2) + PRIME64_3) & MASK64;
		offset += 4;
	}

	while (offset < len) {
		h64 = h64 ^ mul64(BigInt(input[offset]), PRIME64_5);
		h64 = mul64(rotl64(h64, 11), PRIME64_1);
		offset++;
	}

	// Avalanche
	h64 = h64 ^ (h64 >> 33n);
	h64 = mul64(h64, PRIME64_2);
	h64 = h64 ^ (h64 >> 29n);
	h64 = mul64(h64, PRIME64_3);
	h64 = h64 ^ (h64 >> 32n);

	return h64 & MASK64;
}

/**
 * xxHash64 seed used by Claude Code's CCH signing algorithm (per
 * `claude_signing.go` in CLIProxyAPIPlus).
 */
export const CLAUDE_CCH_SEED = 0x6e52736ac806831en;

// ---------------------------------------------------------------------------
// 9-block system[] assembly.
//
// Real Claude Code emits system[] as 9 separate text entries. Anthropic's
// server validates the structure, order, and content of these blocks against
// the canonical v2.1.108 shape. Concatenating them into a single block is a
// detectable fingerprint and gets OAuth requests flagged.
// ---------------------------------------------------------------------------

export interface ClaudeCodeSystemBlock {
	type: "text";
	text: string;
}

export interface BuildSystemBlocksOptions {
	/**
	 * Serialized request body bytes used to compute the `cch` field of the
	 * billing header. Should be the payload before 9-block injection (i.e.
	 * containing the user's original system prompt as system[0]).
	 */
	payload: Uint8Array;
	/**
	 * Free-form user system text used to derive the 3-char build fingerprint.
	 * Pass the user's original systemPrompt (or "") — the fingerprint reads
	 * code points 4, 7, and 20.
	 */
	userSystemText: string;
	/**
	 * Tool names declared for the current request. Used to choose between
	 * TaskCreate vs TodoWrite in the "# Using your tools" block.
	 */
	toolNames: readonly string[];
	version?: string;
	entrypoint?: string;
	workload?: string;
}

// ---------------------------------------------------------------------------
// Anthropic-Beta + outbound OAuth headers.
// ---------------------------------------------------------------------------

/**
 * Canonical beta feature list sent by Claude Code 2.1.108 for OAuth requests.
 * Order matches the fork's emission.
 */
export const CLAUDE_CODE_BASE_BETAS: readonly string[] = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"structured-outputs-2025-12-15",
	"fast-mode-2026-02-01",
	"redact-thinking-2026-02-12",
	"token-efficient-tools-2026-03-28",
];

export interface BuildBetaOptions {
	/** Extra beta tags to append (de-duplicated). */
	extraBetas: readonly string[];
	/** When true, append effort-2025-11-24 (used when thinking is adaptive). */
	injectEffort: boolean;
}

export function buildOAuthBetaString(options: BuildBetaOptions): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const b of CLAUDE_CODE_BASE_BETAS) {
		if (seen.has(b)) continue;
		seen.add(b);
		out.push(b);
	}
	if (options.injectEffort && !seen.has("effort-2025-11-24")) {
		seen.add("effort-2025-11-24");
		out.push("effort-2025-11-24");
	}
	for (const b of options.extraBetas) {
		if (!b || seen.has(b)) continue;
		seen.add(b);
		out.push(b);
	}
	return out.join(",");
}

export interface BuildHeadersOptions {
	apiKey: string;
	isAnthropicBase?: boolean;
}

/**
 * Build the fingerprint-reducing headers that accompany an OAuth cloaked
 * request. Does NOT include Authorization — the SDK handles that from the
 * token. Does NOT include Anthropic-Beta — use buildOAuthBetaString for that.
 * Does NOT include Anthropic-Dangerous-Direct-Browser-Access — real Claude
 * Code never sends it, and emitting it is a fingerprint tell.
 */
export function buildOAuthHeaders(options: BuildHeadersOptions): Record<string, string> {
	const headers: Record<string, string> = {
		"user-agent": CLAUDE_CODE_USER_AGENT,
		"X-App": "cli",
		"Anthropic-Version": "2023-06-01",
		"X-Stainless-Lang": "js",
		"X-Stainless-Runtime": "node",
		"X-Stainless-Retry-Count": "0",
		"X-Stainless-Timeout": "600",
		"X-Stainless-Package-Version": CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
		"X-Stainless-Runtime-Version": CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
		"X-Stainless-Os": CLAUDE_CODE_STAINLESS_OS,
		"X-Stainless-Arch": CLAUDE_CODE_STAINLESS_ARCH,
		"X-Claude-Code-Session-Id": cachedSessionId(options.apiKey),
	};
	if (options.isAnthropicBase) {
		headers["x-client-request-id"] = randomUUID();
	}
	return headers;
}

/**
 * Build the canonical 9-entry system[] used by Claude Code v2.1.108:
 *   [0] x-anthropic-billing-header
 *   [1] "You are Claude Code, Anthropic's official CLI for Claude."
 *   [2] CLAUDE_CODE_INTRO
 *   [3] CLAUDE_CODE_SYSTEM  (# System)
 *   [4] CLAUDE_CODE_DOING_TASKS  (# Doing tasks)
 *   [5] CLAUDE_CODE_ACTIONS  (# Executing actions with care)
 *   [6] buildUsingToolsSection(resolveTaskToolName(toolNames))
 *   [7] CLAUDE_CODE_TONE_AND_STYLE
 *   [8] CLAUDE_CODE_OUTPUT_EFFICIENCY
 */
export function buildClaudeCodeSystemBlocks(
	options: BuildSystemBlocksOptions,
): ClaudeCodeSystemBlock[] {
	const version = options.version ?? CLAUDE_CODE_VERSION;
	const billingHeader = generateBillingHeader(
		options.payload,
		version,
		options.userSystemText,
		options.entrypoint,
		options.workload,
	);
	const taskToolName = resolveTaskToolName(options.toolNames);
	const usingTools = buildUsingToolsSection(taskToolName);

	return [
		{ type: "text", text: billingHeader },
		{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
		{ type: "text", text: CLAUDE_CODE_INTRO },
		{ type: "text", text: CLAUDE_CODE_SYSTEM },
		{ type: "text", text: CLAUDE_CODE_DOING_TASKS },
		{ type: "text", text: CLAUDE_CODE_ACTIONS },
		{ type: "text", text: usingTools },
		{ type: "text", text: CLAUDE_CODE_TONE_AND_STYLE },
		{ type: "text", text: CLAUDE_CODE_OUTPUT_EFFICIENCY },
	];
}

// ---------------------------------------------------------------------------
// Orchestrator: apply every body-side cloaking transformation to a built
// Anthropic MessageCreateParams in-place. Headers are separate (buildOAuthHeaders).
// ---------------------------------------------------------------------------

export interface ApplyCloakingInput {
	apiKey: string;
	/** User's original system prompt text. If sanitize=true, gets replaced
	 *  with a neutral reminder; otherwise passed through verbatim. Either way,
	 *  it is prepended to the first user message so the model still sees it. */
	systemPrompt?: string;
	/** Sanitize user system prompt down to a neutral reminder (strongest cloak).
	 *  Default caller choice; see anthropic.ts option wiring. */
	sanitize: boolean;
	/** `cc_entrypoint` field in billing header. Default "cli". */
	entrypoint?: string;
	/** `cc_workload` field in billing header. Default omitted. */
	workload?: string;
	/** Override Claude Code version string. Default CLAUDE_CODE_VERSION. */
	version?: string;
	/** Alias scheme for custom tools. Default "mcp". See BuildToolAliasesOptions. */
	aliasScheme?: "short" | "mcp" | "mcp-opaque";
	/** Server pseudo-name for `mcp` scheme. Default "local". */
	mcpServerName?: string;
}

export interface ApplyCloakingResult {
	/** alias → original name. Use to restore tool names on inbound stream events. */
	toolAliasReverse: Map<string, string>;
	/** Whether `output_config.effort` was set as a result of this call. */
	effortInjected: boolean;
}

// Minimal type surface for the mutations below. Avoids tight coupling to the
// Anthropic SDK's evolving MessageCreateParams type — we only need to poke at
// `system`, `tools`, `tool_choice`, `messages`, `thinking`, `output_config`.
// Properties are typed loosely because the SDK type uses union+null variants
// that would otherwise require unsafe casts at every call site.
interface CloakableParams {
	system?: unknown;
	tools?: Array<unknown>;
	tool_choice?: unknown;
	messages?: Array<{ role?: string; content?: unknown }>;
	thinking?: unknown;
	output_config?: unknown;
}

type MaybeToolLike = { name?: unknown; type?: unknown } | undefined | null;

function rewriteParamsToolNames(
	params: CloakableParams,
	forward: Map<string, string>,
): void {
	if (forward.size === 0) return;

	if (Array.isArray(params.tools)) {
		for (const tool of params.tools as MaybeToolLike[]) {
			if (tool && typeof tool.name === "string") {
				const alias = forward.get(tool.name);
				if (alias) (tool as { name: string }).name = alias;
			}
		}
	}

	const tc = params.tool_choice as { type?: string; name?: string } | undefined;
	if (tc && tc.type === "tool" && typeof tc.name === "string") {
		const alias = forward.get(tc.name);
		if (alias) tc.name = alias;
	}

	if (Array.isArray(params.messages)) {
		for (const msg of params.messages) {
			if (!msg || !Array.isArray(msg.content)) continue;
			for (const block of msg.content as Array<{ type?: string; name?: string; tool_name?: string; content?: unknown }>) {
				if (!block) continue;
				if (block.type === "tool_use" && typeof block.name === "string") {
					const alias = forward.get(block.name);
					if (alias) block.name = alias;
				} else if (block.type === "tool_reference" && typeof block.tool_name === "string") {
					const alias = forward.get(block.tool_name);
					if (alias) block.tool_name = alias;
				} else if (block.type === "tool_result" && Array.isArray(block.content)) {
					for (const nested of block.content as Array<{ type?: string; tool_name?: string }>) {
						if (nested?.type === "tool_reference" && typeof nested.tool_name === "string") {
							const alias = forward.get(nested.tool_name);
							if (alias) nested.tool_name = alias;
						}
					}
				}
			}
		}
	}
}

function collectToolNamesForPromptSelection(params: CloakableParams): string[] {
	if (!Array.isArray(params.tools)) return [];
	const names: string[] = [];
	for (const t of params.tools as MaybeToolLike[]) {
		if (t && typeof t.name === "string") names.push(t.name);
	}
	return names;
}

function prependToFirstUserMessage(params: CloakableParams, text: string): void {
	if (!text || text.trim().length === 0) return;
	if (!Array.isArray(params.messages)) return;
	const first = params.messages.find((m) => m?.role === "user");
	if (!first) return;

	if (typeof first.content === "string") {
		first.content = `${text}\n\n${first.content}`;
		return;
	}
	if (Array.isArray(first.content)) {
		// Insert a text block at the head of the content array.
		(first.content as unknown[]).unshift({ type: "text", text });
	}
}

function reconstructToolsForAlias(params: CloakableParams): Tool[] {
	if (!Array.isArray(params.tools)) return [];
	const out: Tool[] = [];
	for (const t of params.tools as MaybeToolLike[]) {
		if (!t || typeof t.name !== "string") continue;
		// `type` on a tool entry marks it as an Anthropic server-side builtin
		// (e.g. web_search_20250305). Skip — these never get aliased.
		// The SDK type "custom" is the Anthropic name for a user-defined tool,
		// so we only skip truly-server-side types here.
		if (typeof t.type === "string" && t.type.length > 0 && t.type !== "custom") {
			continue;
		}
		out.push({ name: t.name } as Tool);
	}
	return out;
}

function reconstructMessagesForAlias(params: CloakableParams): Message[] {
	if (!Array.isArray(params.messages)) return [];
	const out: Message[] = [];
	for (const msg of params.messages) {
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const toolCalls: Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> = [];
		for (const block of msg.content as Array<{ type?: string; name?: string; id?: string; input?: unknown }>) {
			if (block?.type === "tool_use" && typeof block.name === "string") {
				toolCalls.push({
					type: "toolCall",
					id: block.id ?? "",
					name: block.name,
					arguments: (block.input as Record<string, unknown>) ?? {},
				});
			}
		}
		if (toolCalls.length > 0) {
			out.push({ role: "assistant", content: toolCalls } as unknown as Message);
		}
	}
	return out;
}

export function applyOAuthCloaking(
	params: CloakableParams,
	input: ApplyCloakingInput,
): ApplyCloakingResult {
	// 1. Effort injection happens first so it contributes to the payload bytes
	//    we'll hash for the billing cch.
	const effortBefore = (params.output_config as { effort?: string } | undefined)?.effort;
	ensureDefaultEffort(params, "medium");
	const effortAfter = (params.output_config as { effort?: string } | undefined)?.effort;
	const effortInjected = effortBefore === undefined && effortAfter !== undefined;

	// 2. Build alias maps from the current tool list + message history, and
	//    rewrite every reference to a custom tool name. Builtins pass through.
	const tools = reconstructToolsForAlias(params);
	const messages = reconstructMessagesForAlias(params);
	const aliases = buildToolAliases(tools, messages, {
		scheme: input.aliasScheme ?? "mcp",
		mcpServerName: input.mcpServerName,
	});
	rewriteParamsToolNames(params, aliases.forward);

	// 3. Snapshot the current payload for the billing cch. Do NOT include
	//    system[] yet — it hasn't been rebuilt. This matches the fork's
	//    `checkSystemInstructionsWithSigningMode` which hashes the pre-inject
	//    body.
	const userSystemText = input.systemPrompt ?? "";
	const preInjectBody = { ...params, system: userSystemText.length > 0 ? [{ type: "text", text: userSystemText }] : undefined };
	const payload = new TextEncoder().encode(JSON.stringify(preInjectBody));

	// 4. Build and assign the 9 system blocks.
	const toolNamesForPrompt = collectToolNamesForPromptSelection(params);
	const systemBlocks = buildClaudeCodeSystemBlocks({
		payload,
		userSystemText,
		toolNames: toolNamesForPrompt,
		entrypoint: input.entrypoint,
		workload: input.workload,
		version: input.version,
	});
	params.system = systemBlocks as unknown as CloakableParams["system"];

	// 5. Prepend forwarded user system (optionally sanitized) to first user msg.
	const forwarded = input.sanitize
		? sanitizeForwardedSystemPrompt(userSystemText)
		: userSystemText;
	if (forwarded.trim().length > 0) {
		prependToFirstUserMessage(params, forwarded);
	}

	return { toolAliasReverse: aliases.reverse, effortInjected };
}

const CCH_PATTERN = /\bcch=([0-9a-f]{5});/;

/**
 * Re-sign the `cch` field of the billing header in a JSON request body using
 * xxHash64 over the body with `cch=00000` stamped in (matching the Go fork's
 * `signAnthropicMessagesBody`). Returns the body unchanged if no billing
 * header is present in `system.0.text`.
 *
 * Input/output are UTF-8 JSON bytes, kept as `Uint8Array` since the hash is
 * defined over the exact byte sequence sent on the wire.
 */
export function signAnthropicMessagesBody(bodyJson: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyJson);
	} catch {
		return bodyJson;
	}
	const system = (parsed as { system?: unknown }).system;
	if (!Array.isArray(system) || system.length === 0) return bodyJson;
	const first = system[0] as { type?: string; text?: string };
	if (first?.type !== "text" || typeof first.text !== "string") return bodyJson;
	if (!first.text.startsWith("x-anthropic-billing-header:")) return bodyJson;
	if (!CCH_PATTERN.test(first.text)) return bodyJson;

	// Stamp cch=00000 and serialize
	const unsignedText = first.text.replace(CCH_PATTERN, "cch=00000;");
	(system[0] as { text: string }).text = unsignedText;
	const unsignedJson = JSON.stringify(parsed);

	const h = xxHash64(new TextEncoder().encode(unsignedJson), CLAUDE_CCH_SEED);
	const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

	const signedText = unsignedText.replace(CCH_PATTERN, `cch=${cch};`);
	(system[0] as { text: string }).text = signedText;
	return JSON.stringify(parsed);
}
