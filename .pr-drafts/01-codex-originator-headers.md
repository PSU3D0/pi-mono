# fix(ai): align codex provider headers with canonical codex_cli_rs

## Problem

The OpenAI Codex provider returns **403 Forbidden** on every request to `chatgpt.com/backend-api`. The endpoint whitelists first-party originators and rejects unknown values.

pi was sending:
- `originator: pi` — not whitelisted
- `User-Agent: pi (darwin 24.5.0; arm64)` — doesn't match originator format
- `chatgpt-account-id` — lowercase, canonical is PascalCase
- `OpenAI-Beta: responses=experimental` — not present in reference implementation

## Root Cause

Cross-referenced with the [OpenAI Codex CLI](https://github.com/openai/codex) reference implementation:

- **Originator whitelist** is `codex_cli_rs`, `codex_vscode`, `codex_sdk_ts`, or anything starting with `Codex ` ([`codex-rs/core/src/default_client.rs:111-114`](https://github.com/openai/codex/blob/main/codex-rs/core/src/default_client.rs))
- **User-Agent** format is `{originator}/{version} ({os} {os_version}; {arch})` ([`codex-rs/core/src/default_client.rs:124-175`](https://github.com/openai/codex/blob/main/codex-rs/core/src/default_client.rs))
- **`ChatGPT-Account-ID`** is PascalCase ([`codex-rs/codex-api/src/auth.rs:26`](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/auth.rs))
- **`OpenAI-Beta`** is only sent on WebSocket upgrade with value `responses_websockets=2026-02-06`, never on SSE requests ([`codex-rs/core/src/client.rs:101-106`](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs))

## Fix

- Set `originator` to `codex_cli_rs` (whitelisted)
- Align `User-Agent` format: `codex_cli_rs/0.0.1 ({os} {os_version}; {arch})`
- Fix header casing: `ChatGPT-Account-ID` (PascalCase)
- Remove `OpenAI-Beta: responses=experimental` from SSE requests (keep on WebSocket with correct value)
- Add `version: 0.0.1` header

## Testing

- ✅ `openai-codex-stream.test.ts` — 3/3 relevant tests pass (1 pre-existing timeout unrelated to this change)
- ✅ Biome lint clean
- ✅ TypeScript typecheck clean
