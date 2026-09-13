#!/usr/bin/env node
/**
 * install.mjs — copy-mode installer for people who don't want to use the plugin
 * system. Puts the agent, skill, harness scripts and status line into ~/.claude
 * and wires the status line into ~/.claude/settings.json.
 *
 *   node install.mjs                  # install everything
 *   node install.mjs --dry-run        # show what would change, touch nothing
 *   node install.mjs --force          # overwrite an existing statusLine entry
 *   node install.mjs --no-statusline  # skip the status line entirely
 *   node install.mjs --with-claude-md # also append the routing rule to ~/.claude/CLAUDE.md
 *
 * If you installed this as a Claude Code plugin instead (see README), you do NOT
 * need this script for the agent/skill/harness — only `--statusline-only` is
 * useful there, because plugins cannot set statusLine in your user settings.
 *
 *   node install.mjs --statusline-only
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, header, item, kv } from './scripts/lib/ui.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const FORCE = args.has('--force');
const NO_STATUSLINE = args.has('--no-statusline');
const STATUSLINE_ONLY = args.has('--statusline-only');
const WITH_CLAUDE_MD = args.has('--with-claude-md');

const did = { copied: 0, skipped: 0 };
const say = (status, label, hint) => console.log(item(status, label, hint));

function toPosix(p) { return p.replace(/\\/g, '/'); }

/** Copy a file, rewriting plugin-root references to the ~/.claude layout. */
function installFile(rel, destRel, { rewrite = false } = {}) {
  const src = path.join(ROOT, rel);
  const dest = path.join(CLAUDE, destRel);
  if (!fs.existsSync(src)) { say('fail', `missing source ${rel}`); return; }

  let content = fs.readFileSync(src);
  if (rewrite) {
    content = Buffer.from(
      content.toString('utf8')
        .replaceAll('${CLAUDE_PLUGIN_ROOT}/scripts/', toPosix(path.join(CLAUDE, 'scripts')) + '/')
        .replaceAll('$env:CLAUDE_PLUGIN_ROOT\\scripts\\', '$env:USERPROFILE\\.claude\\scripts\\'),
      'utf8',
    );
  }

  if (DRY) { say('info', `would copy ${rel} → ${destRel}`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  did.copied++;
  say('ok', `${rel} → ~/.claude/${toPosix(destRel)}`);
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function installStatusLine() {
  const settingsPath = path.join(CLAUDE, 'settings.json');
  const target = path.join(CLAUDE, 'statusline.mjs');
  const command = `node "${toPosix(target)}"`;

  const settings = readJson(settingsPath) ?? {};
  if (fs.existsSync(settingsPath) && readJson(settingsPath) === null) {
    say('fail', '~/.claude/settings.json exists but is not valid JSON — fix it first, nothing was changed');
    return;
  }

  if (settings.statusLine && !FORCE) {
    say('warn', 'statusLine already configured — left as-is', `current: ${settings.statusLine.command}\n    re-run with --force to replace it`);
    did.skipped++;
    return;
  }

  const next = { ...settings, statusLine: { type: 'command', command, padding: 0 } };
  if (DRY) { say('info', `would set statusLine.command = ${command}`); return; }

  if (fs.existsSync(settingsPath)) {
    const backup = settingsPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(settingsPath, backup);
    say('info', `backed up settings.json → ${path.basename(backup)}`);
  }
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
  say('ok', `statusLine wired into ~/.claude/settings.json`);
}

function installClaudeMd() {
  const rule = fs.readFileSync(path.join(ROOT, 'docs', 'routing-rule.md'), 'utf8');
  const block = rule.slice(rule.indexOf('<!-- BEGIN'), rule.indexOf('<!-- END') + '<!-- END claude-codex-orchestrator -->'.length);
  const target = path.join(CLAUDE, 'CLAUDE.md');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (existing.includes('<!-- BEGIN claude-codex-orchestrator -->')) {
    say('warn', '~/.claude/CLAUDE.md already contains the routing rule — skipped');
    return;
  }
  if (DRY) { say('info', 'would append routing rule to ~/.claude/CLAUDE.md'); return; }
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(target, (existing ? existing.trimEnd() + '\n\n' : '') + block + '\n');
  say('ok', 'routing rule appended to ~/.claude/CLAUDE.md');
}

// --------------------------------------------------------------------------- //
console.log(c.bold('claude-codex-orchestrator installer') + (DRY ? c.dim('  (dry run — nothing will be written)') : ''));
console.log(kv('source', ROOT));
console.log(kv('target', CLAUDE));

if (!STATUSLINE_ONLY) {
  console.log(header('Pipeline files'));
  installFile('scripts/lib/ui.mjs',               'scripts/lib/ui.mjs');
  installFile('scripts/codex-scoped-run.mjs',     'scripts/codex-scoped-run.mjs');
  installFile('scripts/codex-doctor.mjs',         'scripts/codex-doctor.mjs');
  installFile('agents/codex-implementer.md',      'agents/codex-implementer.md',      { rewrite: true });
  installFile('skills/codex-pipeline/SKILL.md',   'skills/codex-pipeline/SKILL.md',   { rewrite: true });
}

if (!NO_STATUSLINE) {
  console.log(header('Status line'));
  installFile('statusline/statusline.mjs', 'statusline.mjs');
  installStatusLine();
}

if (WITH_CLAUDE_MD) {
  console.log(header('Routing rule'));
  installClaudeMd();
}

console.log(header('Next'));
console.log(c.dim('  1. Restart Claude Code so it picks up the new agent, skill and status line.'));
console.log(c.dim('  2. Run the doctor:  node ~/.claude/scripts/codex-doctor.mjs'));
if (!WITH_CLAUDE_MD) console.log(c.dim('  3. Optional: add the routing rule to CLAUDE.md — see docs/routing-rule.md, or re-run with --with-claude-md'));
