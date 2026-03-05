# fix(ai): use skip_thought_signature_validator for unsigned Gemini 3 tool calls

## Problem

Gemini 3 models return tool calls without `thought_signatures`, which causes validation errors when these unsigned function calls are included in subsequent API requests. The current workaround converts prior function calls to text-format historical notes, which loses structured function call context and can cause hallucinations when the model sees its own tool use described as prose rather than as actual API calls.

## Root Cause

The Gemini API supports a sentinel value `skip_thought_signature_validator` as an officially documented feature for skipping thought signature validation. This is used by:

- [gemini-cli](https://github.com/google-gemini/gemini-cli)
- Google .NET SDK (`PredictionServiceChatClient.cs`)
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) ([`src/constants.ts:201`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts), [`src/plugin/request-helpers.ts:1166`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/plugin/request-helpers.ts))

See also: https://ai.google.dev/gemini-api/docs/thought-signatures

## Fix

Replace the text-fallback conversion with the `skip_thought_signature_validator` sentinel value. For Gemini 3 model responses that contain unsigned function calls, set `thoughtSignature: "skip_thought_signature_validator"` on the function call parts. This preserves proper function call structure in the API payload and avoids hallucination from text-format historical context notes.

## Testing

- ✅ New test: `google-shared-gemini3-unsigned-tool-call.test.ts` — verifies sentinel is applied to unsigned function calls
- ✅ Biome lint clean
- ✅ TypeScript typecheck clean
