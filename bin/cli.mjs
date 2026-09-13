#!/usr/bin/env node
/**
 * claude-codex-orchestrator — tiny dispatcher so the pieces are reachable via npx:
 *
 *   npx claude-codex-orchestrator doctor            preflight check
 *   npx claude-codex-orchestrator doctor --prune    also clear stale worktrees
 *   npx claude-codex-orchestrator run <harness args> run the scope-enforced harness
 *   npx claude-codex-orchestrator install [flags]   copy-mode install into ~/.claude
 *   npx claude-codex-orchestrator statusline        render the status line (reads JSON on stdin)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMMANDS = {
  doctor:     path.join(ROOT, 'scripts', 'codex-doctor.mjs'),
  run:        path.join(ROOT, 'scripts', 'codex-scoped-run.mjs'),
  install:    path.join(ROOT, 'install.mjs'),
  statusline: path.join(ROOT, 'statusline', 'statusline.mjs'),
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '-h' || cmd === '--help' || !COMMANDS[cmd]) {
  const usage = `claude-codex-orchestrator <command> [args]

commands:
  doctor        preflight check for the pipeline (add --prune to clear stale worktrees)
  run           run the scope-enforced Codex harness (see: run --help)
  install       copy-mode install into ~/.claude (see: install --help)
  statusline    render the status line; expects Claude Code's session JSON on stdin
`;
  process.stderr.write(usage);
  process.exit(cmd && !COMMANDS[cmd] ? 1 : 0);
}

const child = spawn(process.execPath, [COMMANDS[cmd], ...rest], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => { process.stderr.write(`failed to start ${cmd}: ${err.message}\n`); process.exit(1); });
