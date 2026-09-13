#!/usr/bin/env node
/**
 * codex-doctor.mjs — preflight check for the local Claude→Codex pipeline.
 *
 *   node ~/.claude/scripts/codex-doctor.mjs           # report status
 *   node ~/.claude/scripts/codex-doctor.mjs --prune   # also remove stale codex worktrees
 *
 * Checks everything the harness needs, grouped into sections, and prints exact
 * remediation for anything missing.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, header, item, kv, summary, code } from './lib/ui.mjs';

const PRUNE = process.argv.includes('--prune');
const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Everything is resolved relative to this file, so the doctor works whether the
// plugin lives in a plugin directory, a git checkout, or was copied to ~/.claude.
const ROOT = path.resolve(HERE, '..');
const SELF = path.join(HERE, 'codex-doctor.mjs');
const HARNESS = path.join(HERE, 'codex-scoped-run.mjs');

const counts = { ok: 0, warn: 0, fail: 0 };
function report(status, label, hint) {
  counts[status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'ok']++;
  console.log(item(status, label, hint));
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000, shell: process.platform === 'win32',
    }).trim();
  } catch { return null; }
}

console.log(c.bold('Claude → Codex pipeline doctor'));

// --- Core tooling ---------------------------------------------------------- //
console.log(header('Environment'));

const nodeV = process.version;
const nodeMajor = parseInt(nodeV.slice(1), 10);
nodeMajor >= 18 ? report('ok', `node ${nodeV}`) : report('fail', `node ${nodeV} is too old`, 'Install Node 18+');

const gitV = tryRun('git', ['--version']);
gitV ? report('ok', gitV) : report('fail', 'git not found on PATH', 'Install Git and reopen your terminal');

// --- Codex CLI --------------------------------------------------------------- //
console.log(header('Codex CLI'));

const codexV = tryRun('codex', ['--version']);
if (codexV) {
  report('ok', `codex ${codexV}`);
} else {
  report('fail', 'codex CLI not found on PATH', 'npm install -g @openai/codex   (then run: codex   and sign in)');
}

const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
const authFile = path.join(codexHome, 'auth.json');
const configFile = path.join(codexHome, 'config.toml');

if (fs.existsSync(authFile)) {
  report('ok', `signed in (${authFile.replace(HOME, '~')})`);
} else if (process.env.OPENAI_API_KEY) {
  report('ok', 'authenticated via OPENAI_API_KEY');
} else {
  report('fail', 'no codex credentials found', 'Run `codex` once and sign in with your ChatGPT account, or set OPENAI_API_KEY');
}

if (fs.existsSync(configFile)) {
  const cfg = fs.readFileSync(configFile, 'utf8');
  const model = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  const effort = cfg.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
  report('ok', `config: model=${model || '(unset — codex default)'} effort=${effort || '(unset — codex default)'}`);
} else {
  report('warn', `no ${configFile.replace(HOME, '~')}`,
    'Optional — codex-cli 0.153+ defaults to gpt-6-astra with no config needed. The harness omits --model/--effort unless you pass them.');
}

// --- Pipeline files ---------------------------------------------------------- //
console.log(header('Pipeline files'));

for (const rel of [
  'scripts/lib/ui.mjs',
  'scripts/codex-scoped-run.mjs',
  'agents/codex-implementer.md',
  'skills/codex-pipeline/SKILL.md',
]) {
  const p = path.join(ROOT, rel);
  fs.existsSync(p) ? report('ok', rel) : report('fail', `missing ${rel}`);
}
// The status line ships under statusline/ in the repo and lands at ~/.claude/statusline.mjs when copied.
const statuslineHit = [path.join(ROOT, 'statusline', 'statusline.mjs'), path.join(HOME, '.claude', 'statusline.mjs')]
  .find((p) => fs.existsSync(p));
statuslineHit ? report('ok', `statusline.mjs (${statuslineHit.replace(HOME, '~')})`) : report('warn', 'statusline.mjs not found', 'optional — run: node install.mjs');

// --- Status line -------------------------------------------------------------- //
console.log(header('Status line'));

try {
  const s = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
  if (s.statusLine?.command) report('ok', `configured: ${s.statusLine.command}`);
  else report('fail', 'statusLine not configured in ~/.claude/settings.json');
} catch {
  report('fail', 'could not read ~/.claude/settings.json');
}

// --- Housekeeping --------------------------------------------------------------- //
console.log(header('Housekeeping'));

const tmp = os.tmpdir();
let stale = [];
try {
  stale = fs.readdirSync(tmp)
    .filter((n) => n.startsWith('codex-wt-'))
    .map((n) => path.join(tmp, n))
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
} catch { /* noop */ }

if (!stale.length) {
  report('ok', 'no leftover codex worktrees in temp');
} else if (PRUNE) {
  for (const p of stale) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
  }
  report('ok', `pruned ${stale.length} leftover worktree${stale.length === 1 ? '' : 's'}`,
    'also run: git -C <repo> worktree prune');
} else {
  report('warn', `${stale.length} leftover codex worktree${stale.length === 1 ? '' : 's'} in temp`,
    `clear with: node "${SELF}" --prune`);
  stale.slice(0, 5).forEach((p) => console.log(c.dim(`      ${p}`)));
  if (stale.length > 5) console.log(c.dim(`      … and ${stale.length - 5} more`));
}

// --- Summary --------------------------------------------------------------- //
console.log(header('Summary'));
console.log(`  ${summary(counts)}`);

if (counts.fail === 0) {
  console.log(`\n${c.cyan('Smoke test')} — in any clean git repo:`);
  console.log(code(
    `node "${HARNESS}" --repo . --allow "README.md" \\\n` +
    '  --prompt "Add a line \'hello from codex\' to the end of README.md. Apply the edit and STOP." --dry-run'
  ));
  console.log(c.dim('Drop --dry-run once the command looks right.'));
}

process.exit(counts.fail > 0 ? 1 : 0);
