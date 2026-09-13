# Routing rule for CLAUDE.md

Claude Code loads `~/.claude/CLAUDE.md` (all projects) and `./CLAUDE.md` (one
project) into every session. Paste the block below into whichever you prefer so
Claude knows the pipeline exists and how to run it correctly. `install.mjs
--with-claude-md` appends it to `~/.claude/CLAUDE.md` for you.

The block is **opt-in** by default: Claude only routes work to Codex when you
ask. The comment at the bottom shows the one-line change that makes Codex the
default for all substantive implementation.

```markdown
<!-- BEGIN claude-codex-orchestrator -->
## Claude → Codex pipeline (Claude thinks, Codex executes)

A local pipeline routes each phase of a coding task to the model family that is
stronger at it: **Claude** researches, scopes, reviews, and verifies; **Codex
(GPT)** writes the implementation inside a scope-enforced harness.

**Use it when** the user says "with codex", invokes `/codex-pipeline`, or asks
for GPT to implement something. Load the `codex-pipeline` skill for the full
workflow; delegate the implementation step to the `codex-implementer` subagent.

Non-negotiables when running it:

- **Claude scopes first.** Read the code and define a tight file allowlist
  before any Codex run. Never delegate an unscoped task.
- **Codex applies edits and STOPS.** Never tell it to build or run tests — it is
  sandboxed, would hang on a blocked command, and the watchdog would kill a
  healthy run.
- **Claude owns build + verification**, always, after the fact.
- **A stall with edits applied is a success**, not a failure. Review the diff;
  do not blindly re-run.

<!-- To make Codex the default for ALL substantive implementation rather than
     opt-in, change "Use it when" above to: "Route every substantive code
     implementation (features, bug fixes, multi-file refactors) to
     codex-implementer; keep research, scoping, and review on Claude. Trivial
     one-line edits and file operations stay with Claude." -->

Troubleshooting: `npx claude-codex-orchestrator doctor`
<!-- END claude-codex-orchestrator -->
```
