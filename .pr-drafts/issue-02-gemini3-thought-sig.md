---
title: "Gemini 3 unsigned tool calls: use skip_thought_signature_validator instead of text fallback"
labels: bug, pkg:ai
---

Gemini 3 models return tool calls without `thought_signatures`. The current code works around this by converting prior function calls into text-format historical notes before sending them back. This loses the structured function call context — the model sees its own tool use described as prose, which can cause hallucinations on multi-turn tool-use conversations.

The Gemini API has an official sentinel value for this: `skip_thought_signature_validator`. You set it as the `thoughtSignature` on unsigned function call parts and the API skips validation instead of rejecting. It's documented at https://ai.google.dev/gemini-api/docs/thought-signatures and used by gemini-cli and the Google .NET SDK.

The [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) project does the same thing ([`constants.ts:201`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts), [`request-helpers.ts:1166`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/plugin/request-helpers.ts)).

The fix replaces the text-fallback conversion with the sentinel in `google-shared.ts`. Net -7 lines. I have a branch with a test ready: [`fix/gemini3-thought-signature`](https://github.com/PSU3D0/pi-mono/tree/fix/gemini3-thought-signature).
