---
title: "Codex provider sends wrong originator/headers → 403 Forbidden"
labels: bug, pkg:ai
---

The OpenAI Codex provider gets 403 on every request to `chatgpt.com/backend-api`. Dug into the [Codex CLI source](https://github.com/openai/codex) to figure out why.

The endpoint whitelists first-party originators. pi sends `originator: pi`, which isn't on the list. The whitelist is `codex_cli_rs`, `codex_vscode`, `codex_sdk_ts`, or anything starting with `Codex ` ([`default_client.rs:111-114`](https://github.com/openai/codex/blob/main/codex-rs/core/src/default_client.rs)).

There are a few other header mismatches:

| Header | pi sends | Codex CLI sends |
|--------|----------|-----------------|
| `originator` | `pi` | `codex_cli_rs` |
| `User-Agent` | `pi (darwin ...)` | `codex_cli_rs/0.0.1 (darwin ...)` |
| Account ID header | `chatgpt-account-id` (lowercase) | `ChatGPT-Account-ID` (PascalCase, [`auth.rs:26`](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/auth.rs)) |
| `OpenAI-Beta` | `responses=experimental` on SSE | Only on WebSocket upgrade, value `responses_websockets=2026-02-06` ([`client.rs:101-106`](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)) |

Fix is ~15 lines in `openai-codex-responses.ts`. I have a branch ready: [`fix/codex-originator-headers`](https://github.com/PSU3D0/pi-mono/tree/fix/codex-originator-headers).
