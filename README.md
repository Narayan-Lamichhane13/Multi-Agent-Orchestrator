# claude-codex-orchestrator

**Claude thinks. Codex types. A file allowlist keeps GPT honest.**

A multi-agent CLI orchestrator plugin for [Claude Code](https://claude.com/claude-code). It routes each phase of a coding task to the model family that's stronger at it — **Claude** researches, scopes, reviews, and verifies; **Codex (GPT)** writes the implementation — and wraps the Codex step in a harness that *mechanically reverts anything it touches outside the files you allowed*.

[![tests](https://github.com/Narayan-Lamichhane13/claude-codex-orchestrator/actions/workflows/test.yml/badge.svg)](https://github.com/Narayan-Lamichhane13/claude-codex-orchestrator/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

```
User request
  → Claude scopes        reads the code, decides the change, defines a file allowlist
  → Codex implements     codex-implementer → codex-scoped-run.mjs; applies edits, then STOPS
  → Claude reviews       reads the diff adversarially
  → Claude verifies      runs the real build + tests, unsandboxed
```

Running implementation on one model family and review on another buys **cross-model adversarial diversity**: each catches classes of mistakes the other makes. The harness makes the split safe — GPT literally cannot sprawl beyond the task, because anything outside the allowlist is reverted before Claude ever sees the result.

## Install

You need [Node 18+](https://nodejs.org), `git`, and the [Codex CLI](https://github.com/openai/codex) signed in:

```bash
npm install -g @openai/codex
codex          # sign in with ChatGPT, or set OPENAI_API_KEY
```

Then pick one:

### As a Claude Code plugin (recommended)

Inside Claude Code:

```
/plugin marketplace add Narayan-Lamichhane13/claude-codex-orchestrator
/plugin install claude-codex-orchestrator@claude-codex-orchestrator
```

This registers the `codex-implementer` agent and the `/codex-pipeline` skill. Plugins can't set your status line, so if you want that too:

```bash
npx claude-codex-orchestrator install --statusline-only
```

### Copy-mode (no plugin system)

```bash
git clone https://github.com/Narayan-Lamichhane13/claude-codex-orchestrator
cd claude-codex-orchestrator
node install.mjs            # add --dry-run to preview, --with-claude-md to add the routing rule
```

Copies the agent, skill, harness and status line into `~/.claude/` and wires the status line into `~/.claude/settings.json` (backing up the original first; won't overwrite an existing `statusLine` unless you pass `--force`).

Either way, **restart Claude Code** afterwards, then confirm everything is wired up:

```bash
npx claude-codex-orchestrator doctor
```

## Use it

Just ask Claude Code to do something *with codex*, or invoke the skill directly:

```
/codex-pipeline add rate limiting to the /login route
```

Claude will read the relevant code, decide exactly which files may change, hand a fully-scoped brief to Codex, then review the diff and run your tests. You never call the harness by hand in normal use — but you can:

```bash
npx claude-codex-orchestrator run \
  --repo . \
  --allow "src/auth/session.ts" \
  --allow "src/auth/__tests__/**" \
  --prompt-file task.md
```

### Harness flags

| Flag | Default | Purpose |
|---|---|---|
| `--repo <path>` | *required* | Git repo root |
| `--allow <glob>` | *required, repeatable* | Repo-relative globs Codex may edit. Supports `*`, `?`, `**`, and `dir/` as shorthand for `dir/**` |
| `--prompt-file <f>` / `--prompt <text>` | *required* | The brief for Codex |
| `--model <id>` | codex default | Leave unset — codex-cli 0.153+ defaults to `gpt-6-astra` |
| `--effort low\|medium\|high\|xhigh` | codex default | Reasoning effort |
| `--mode auto\|worktree\|inplace` | `auto` | See [modes](#modes) |
| `--verify-cmd "<cmd>"` | — | Optional command to run after edits (Claude normally does this instead) |
| `--idle-timeout <s>` | `180` | Kill Codex after this long with no output *and* no file changes |
| `--max-runtime <s>` | `1800` | Absolute cap (`0` = unlimited) |
| `--dry-run` | — | Print the exact `codex exec` command, run nothing |
| `--cleanup-worktree` | — | Remove the worktree after the run instead of leaving it for review |

### Modes

- **`worktree`** (default when the tree is clean) — Codex runs in an isolated `git worktree`. Your working copy is never touched; the result comes back as a patch (`patchFile` + `applyCommand` in the JSON).
- **`inplace`** (chosen automatically when the tree is dirty) — Codex edits the repo directly. A worktree built from `HEAD` would silently omit your uncommitted work, so this is the safer choice there. The harness snapshots every already-modified file *before* the run, so "out of scope" means "Codex touched it" — never merely "it differs from HEAD". **Your own WIP is never reverted.**

### What comes back

`stdout` is a single JSON object (logs go to `stderr`), so the calling agent can parse it:

```jsonc
{
  "status": "ok",                     // ok | stalled | error | dry-run
  "mode": "worktree",
  "inScopeChanged": ["src/auth/session.ts", "src/auth/__tests__/session.test.ts"],
  "outOfScopeReverted": ["src/index.ts"],   // Codex tried; the harness undid it
  "preExistingUnchanged": [],               // your WIP, left alone (inplace mode)
  "diffStat": " src/auth/session.ts | 14 +++++---\n ...",
  "patchFile": "/tmp/codex-scoped-1788554952691.patch",
  "applyCommand": "git -C \"/path/to/repo\" apply \"/tmp/codex-scoped-....patch\"",
  "worktree": "/tmp/codex-wt-lZAFlQ",
  "cleanupCommand": "git -C \"/path/to/repo\" worktree remove --force \"/tmp/codex-wt-lZAFlQ\"",
  "verify": { "ran": false, "exitCode": null, "tail": "" },
  "codexExitCode": 0,
  "logTail": "",                            // last 40 lines of Codex output on stall/error
  "notes": ""
}
```

## Operating contracts

These are the rules that make the pipeline reliable. They're baked into the agent and skill; you don't have to remember them, but it helps to know why they exist.

**Codex applies edits, then stops.** The agent always tells Codex *not* to build or run tests. Codex runs sandboxed; a build command it can't run produces no output, and the watchdog would read that silence as a stall and kill an otherwise-healthy run. Claude runs the real build afterwards, unsandboxed.

**A stall is not a failure if edits landed.** `"status": "stalled"` with a non-empty `inScopeChanged` means the watchdog cut off a quiet phase *after* the edits were applied. That counts as delivered — review the diff, don't blindly re-run. The agent only retries (once) when nothing landed.

**Scope enforcement is mechanical, not advisory.** Out-of-scope edits are reverted before the result is returned. A non-empty `outOfScopeReverted` is worth noting — it says something about how well the task was scoped — but needs no re-run.

**Claude scopes first, always.** An unscoped Codex run is the failure mode this whole thing exists to prevent. `src/**` is almost never the right allowlist.

## Status line

Also included: a status line that shows what Claude Code's default footer doesn't — **the effort level** and a **context-pressure bar**, colour-coded green → yellow → red:

```
◆ Opus · effort high · ~/code/app · ⎇ main*
███████░░░░░░░░░  42%  84.0k/200.0k ctx  $1.23  10m  +156/-23
```

Effort isn't in the payload Claude Code sends to status lines, so it's resolved from your settings files using Claude Code's own precedence (project `.local` → project → user), model-specific entry first. Renders in ~250 ms, respects `NO_COLOR`, tolerates the BOM some shells prepend to piped input.

## Make Codex the default

Out of the box the pipeline is **opt-in** — Claude only routes to Codex when you ask. To make Codex the default for all substantive implementation, add the routing rule to your `CLAUDE.md` (`node install.mjs --with-claude-md` does this) and flip the one line described in [docs/routing-rule.md](docs/routing-rule.md).

## Development

```bash
npm test          # node --test — end-to-end tests using a fake `codex` on PATH
npm run doctor
```

The test suite spins up real git repos, puts a fake `codex` executable first on `PATH`, and exercises allowlist enforcement, the watchdog's stall handling, inplace-mode WIP preservation, and the guard rails. No network, no real model calls, no dependencies. Runs on Linux, macOS and Windows in CI.

## Troubleshooting

`npx claude-codex-orchestrator doctor` checks Node, git, the Codex CLI and its credentials, every pipeline file, and the status line wiring, and prints an exact fix for anything missing.

| Symptom | Cause / fix |
|---|---|
| `codex CLI not found` | `npm install -g @openai/codex`, then run `codex` once and sign in |
| Every run stalls with no output | Codex is waiting on an approval prompt — confirm `--sandbox workspace-write` and that you're signed in |
| Status `error`, "not a git repository" | The harness needs git to revert out-of-scope edits |
| Leftover `codex-wt-*` dirs in temp | `npx claude-codex-orchestrator doctor --prune`, then `git worktree prune` |
| Status line doesn't appear | Restart Claude Code; the settings watcher won't pick up a newly *added* `statusLine` mid-session |

## Origin

This is a from-scratch, dependency-free implementation of a Claude-scopes / GPT-implements / Claude-reviews workflow pattern. It contains no proprietary code, model endpoints, or infrastructure — it runs on the public Codex CLI with your own ChatGPT or API-key auth.

## License

[MIT](LICENSE)
