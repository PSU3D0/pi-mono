# TODO

## OpenAI model refresh

- [ ] Fast-forward `ref-libs/openai-codex` and confirm whether GPT-5.5 landed in the latest Codex references/config
- [ ] Update `pi-mono` model registry/provider wiring to expose GPT-5.5 if present upstream
- [ ] Rebuild `pi-mono` and smoke-test model selection/access for GPT-5.5
- [ ] Align easy-win Codex OAuth/provider conventions with upstream Codex (`originator`, OAuth scope, base URL, version/user-agent headers)
- [ ] Compare fork vs latest upstream `pi-mono` for GPT-5.5 / Codex model-catalog changes before deciding on rebase/merge

## Latest upstream merge

- [ ] Commit current smart-title/tree/Codex work as a checkpoint before reconciling upstream
- [ ] Create an isolated worktree from the checkpoint for merging latest `origin/main`
- [ ] Audit upstream changes since v0.67.68, especially model catalog, Anthropic OAuth, and provider/auth wiring
- [ ] Merge/reconcile latest upstream without undoing fork-local behavior
- [ ] Run focused verification before switching the live build

## /tree time filter + title discoverability

- [ ] Add separate `/tree` time filter axis: `all | 1w | 2w | 3w | 1mo`
- [ ] Add persisted setting for default `/tree` time filter
- [ ] Add `/tree` keybindings/help/status text for cycling time filter
- [ ] Ensure time filter preserves current leaf visibility and selection semantics
- [ ] Verify time filter works well with branched/forked sessions where old ancestors are hidden
- [ ] Investigate title discoverability: titled sessions should be findable in `/tree` search and, if needed, `/resume` search
- [ ] Add tests for time filter + title search behavior
