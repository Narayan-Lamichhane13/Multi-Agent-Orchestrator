---
name: codex-pipeline
description: >-
  Run a coding task through the Claude→Codex→Claude pipeline: Claude scopes the
  work and defines a file allowlist, the local Codex CLI implements it inside a
  scope-enforced harness, then Claude reviews the diff and runs the real build
  and tests. Use when the user asks to build, fix, or refactor something "with
  codex", invokes /codex-pipeline, or wants GPT doing the typing while Claude
  does the thinking. Also covers troubleshooting the harness.
---

# Claude → Codex → Claude pipeline

Claude does the thinking; Codex does the execution. Each phase goes to the model
family that is stronger at it, and running implementation on GPT while review
stays on Claude buys cross-model adversarial diversity — each catches classes of
mistakes the other makes.

```
User request
  → Claude scopes        (read the code, decide the change, define the allowlist)
  → Codex implements     (codex-implementer → codex-scoped-run.mjs; edits, then STOPS)
  → Claude reviews       (read the diff critically)
  → Claude verifies      (build + tests, unsandboxed)
```

## Phase 1 — Claude scopes (you, in the main session)

Do the discovery yourself. Read the relevant files, understand the change, and
produce:

- A concrete objective and acceptance criteria.
- **The exact list of files Codex may touch** → these become `--allow` patterns.
  Be tight. `src/**` is almost never the right allowlist; `src/auth/session.ts`
  and `src/auth/__tests__/**` usually is.
- Any constraints worth stating (style, no test deletion, preserve logging).

Never skip this phase. An unscoped Codex run is the failure mode this pipeline
exists to prevent.

## Phase 2 — Codex implements

Delegate to the `codex-implementer` subagent, giving it the objective, the file
list, and the constraints. It forwards to the harness and returns JSON.

For a quick one-off you can also call the harness directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-scoped-run.mjs" \
  --repo . \
  --allow "src/auth/session.ts" \
  --allow "src/auth/__tests__/**" \
  --prompt-file /tmp/task.md
```

Key flags: `--model`, `--effort low|medium|high|xhigh`, `--mode auto|worktree|inplace`,
`--verify-cmd`, `--idle-timeout` (default 180s), `--max-runtime` (default 1800s),
`--dry-run` to print the command without running it. Leave `--model` unset for
codex's own default — codex-cli 0.153+ defaults to **gpt-6-astra** (a 1M+ token
context, reasoning model) automatically, so most invocations don't need it.

**Modes.** `worktree` (default when the tree is clean) runs Codex in an isolated
git worktree, so your working copy is never touched and the result arrives as a
patch. `inplace` edits the repo directly and is chosen automatically when the
tree is dirty — a worktree built from HEAD would silently omit uncommitted work.

## Phase 3 — Claude reviews

Read the returned JSON, then review the actual diff:

- `inScopeChanged` — what survived.
- `outOfScopeReverted` — what Codex tried to touch and the harness undid. Worth
  noting (it says something about how well the task was scoped) but needs no
  re-run; those edits are already gone.
- `preExistingUnchanged` — files that were already dirty before the run and that
  Codex did not touch. The harness leaves these alone: in inplace mode, "out of
  scope" means "Codex changed it", never merely "it differs from HEAD", so your
  own uncommitted work is never reverted.
- `patchFile` / `applyCommand` — in worktree mode, apply the patch to review it
  in place: `git -C <repo> apply <patchFile>`.

Review it as adversarially as you would review any diff. Do not rubber-stamp it
because a model wrote it.

## Phase 4 — Claude verifies

**Claude owns the build and tests.** Codex runs sandboxed and was explicitly told
not to build. Run the real thing yourself: `npm test`, `npx tsc --noEmit`,
whatever the project uses. A small Claude-side fixup after a Codex run is normal,
not a pipeline failure.

## Operating contracts

**Codex applies edits, then stops.** Never instruct it to build or run tests. It
would hit a sandbox-blocked command, go quiet, and the watchdog would kill an
otherwise-healthy run.

**A stall is not a failure if edits landed.** `"status":"stalled"` with a
non-empty `inScopeChanged` means the watchdog killed a quiet phase *after* the
edits were applied. Treat the work as delivered and move to review. Only re-run
when the intended edits are absent or incomplete — check `git status` first.

**Scope enforcement is mechanical, not advisory.** Anything outside the
allowlist is reverted before you ever see it.

## Troubleshooting

Run the doctor first — it checks Node, git, the Codex CLI, credentials, every
pipeline file, and the status line wiring:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-doctor.mjs"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-doctor.mjs" --prune   # clear leftover worktrees
```

| Symptom | Cause / fix |
|---|---|
| `codex CLI not found` | `npm install -g @openai/codex`, then run `codex` once and sign in. |
| Status `error`, "not a git repository" | The harness needs git to revert out-of-scope edits. Run it against a repo. |
| Every run stalls with no output | Codex is probably waiting on an approval prompt. Confirm `--sandbox workspace-write` and that auth is set up. |
| Leftover `codex-wt-*` dirs in temp | `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-doctor.mjs" --prune`, then `git worktree prune`. |
| Worktree still listed after deletion | `git -C <repo> worktree prune` |
