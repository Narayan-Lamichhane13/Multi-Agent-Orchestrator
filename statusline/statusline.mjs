#!/usr/bin/env node
/**
 * statusline.mjs — Claude Code status line: model · effort · context · cost.
 *
 * Wired up via ~/.claude/settings.json (install.mjs does this for you):
 *   "statusLine": { "type": "command", "command": "node \"/abs/path/to/statusline.mjs\"", "padding": 0 }
 * Use an absolute path — node does not expand `~` itself, and on Windows the
 * command may run under PowerShell where `~` is not expanded for arguments either.
 *
 * Line 1:  ◆ Opus  effort high   ~/project  ⎇ main*
 * Line 2:  [████████░░░░░░░░]  38%  76.4k/200k ctx   $0.42  14m
 *
 * Claude Code sends session JSON on stdin. `effort` is not part of that payload,
 * so it is resolved from the settings files using Claude Code's own precedence
 * (project .local > project > user), model-specific entry first.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --------------------------------------------------------------------------- //
// ANSI
// --------------------------------------------------------------------------- //
const e = (n) => `\x1b[${n}m`;
const R = e(0), BOLD = e(1), DIM = e(2);
const CYAN = e(36), BLUE = e(34), YELLOW = e(33), GREEN = e(32), RED = e(31), MAGENTA = e(35), GREY = e(90);

// --------------------------------------------------------------------------- //
// Read stdin
// --------------------------------------------------------------------------- //
/**
 * Parse the payload, tolerating a UTF-8 BOM and wrapper whitespace. Some shells
 * (PowerShell notably) prepend a BOM when piping to a native command, which
 * makes JSON.parse throw on otherwise-valid input.
 */
function tryParse(s) {
  const cleaned = s.replace(/^﻿/, '').trim();
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch { return null; }
}

/**
 * Read the session JSON from stdin.
 *
 * Resolves as soon as the buffer parses as complete JSON rather than waiting for
 * an 'end' event: some Windows shells hold the write handle open after sending,
 * and waiting for EOF there costs a full timeout on every single refresh. The
 * timeout is only a backstop for a truncated or absent payload.
 */
function readStdinJson(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({ raw: '', data: {} });
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve({ raw: buf, data: tryParse(buf) || {} });
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; if (tryParse(buf)) finish(); });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const { raw, data: d } = await readStdinJson();

// Set CLAUDE_STATUSLINE_DEBUG=1 to troubleshoot what the status line receives.
if (process.env.CLAUDE_STATUSLINE_DEBUG) {
  console.error(`[statusline] stdin=${raw.length}B head=${JSON.stringify(raw.slice(0, 12))} keys=[${Object.keys(d).join(',')}]`);
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
const HOME = os.homedir();

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Shorten a path for display: C:\Users\me\code\app -> ~/code/app
 * Separators are normalized first so the home-prefix match works whether the
 * payload uses Windows or POSIX separators.
 */
function prettyDir(dir) {
  if (!dir) return '';
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  let out = norm(dir);
  const home = norm(HOME);
  if (out.toLowerCase() === home.toLowerCase()) return '~';
  if (out.toLowerCase().startsWith(home.toLowerCase() + '/')) out = '~' + out.slice(home.length);
  const parts = out.split('/').filter(Boolean);
  if (parts.length <= 3) return out;
  return (out.startsWith('~') ? '~/' : '.../') + parts.slice(-2).join('/');
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

// --------------------------------------------------------------------------- //
// Effort resolution (settings precedence: project .local > project > user)
// --------------------------------------------------------------------------- //
function resolveEffort(modelId) {
  const projectDir = d.workspace?.project_dir || d.workspace?.current_dir || d.cwd;
  const candidates = [];
  if (projectDir) {
    candidates.push(path.join(projectDir, '.claude', 'settings.local.json'));
    candidates.push(path.join(projectDir, '.claude', 'settings.json'));
  }
  candidates.push(path.join(HOME, '.claude', 'settings.json'));

  for (const file of candidates) {
    const s = readJson(file);
    if (!s) continue;
    const perModel = modelId && s.modelSettings?.[modelId]?.effortLevel;
    if (perModel) return perModel;
    if (s.effortLevel) return s.effortLevel;
  }
  return null;
}

const EFFORT_COLOR = {
  none: GREY, minimal: GREY, low: BLUE, medium: CYAN, high: MAGENTA, xhigh: RED, max: RED,
};

// --------------------------------------------------------------------------- //
// Context window
// --------------------------------------------------------------------------- //
function contextInfo() {
  const cw = d.context_window;
  if (!cw) return null;

  const size = cw.context_window_size || null;
  let used = null;

  const u = cw.current_usage;
  if (u) {
    used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
           (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  }

  let pct = cw.used_percentage;
  if (!Number.isFinite(pct)) {
    pct = (Number.isFinite(used) && size) ? (used / size) * 100 : null;
  }
  // Derive tokens from the percentage when current_usage is null (early session / post-compact).
  if (!Number.isFinite(used) && Number.isFinite(pct) && size) used = Math.round((pct / 100) * size);

  return { size, used, pct: Number.isFinite(pct) ? pct : null };
}

function bar(pct, width = 16) {
  if (!Number.isFinite(pct)) return `${GREY}${'░'.repeat(width)}${R}`;
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const color = clamped >= 85 ? RED : clamped >= 60 ? YELLOW : GREEN;
  return `${color}${'█'.repeat(filled)}${GREY}${'░'.repeat(width - filled)}${R}`;
}

// --------------------------------------------------------------------------- //
// Compose
// --------------------------------------------------------------------------- //
const modelName = d.model?.display_name || d.model?.id || 'Claude';
const modelId = d.model?.id || null;
const effort = resolveEffort(modelId);
const cwd = d.workspace?.current_dir || d.cwd || process.cwd();

// ---- line 1: identity ---- //
const l1 = [`${CYAN}${BOLD}◆ ${modelName}${R}`];

if (effort) {
  const c = EFFORT_COLOR[String(effort).toLowerCase()] || CYAN;
  l1.push(`${DIM}effort${R} ${c}${effort}${R}`);
}

l1.push(`${BLUE}${prettyDir(cwd)}${R}`);

const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch) {
  const dirty = git(cwd, ['status', '--porcelain']) ? '*' : '';
  l1.push(`${YELLOW}⎇ ${branch}${dirty}${R}`);
}

const style = d.output_style?.name;
if (style && style !== 'default') l1.push(`${GREY}${style}${R}`);

// ---- line 2: telemetry ---- //
const ctx = contextInfo();
const l2 = [];

if (ctx) {
  const pctText = Number.isFinite(ctx.pct) ? `${Math.round(ctx.pct)}%` : '--%';
  const pctColor = !Number.isFinite(ctx.pct) ? GREY : ctx.pct >= 85 ? RED : ctx.pct >= 60 ? YELLOW : GREEN;
  l2.push(bar(ctx.pct));
  l2.push(`${pctColor}${BOLD}${pctText}${R}`);
  if (Number.isFinite(ctx.used) && ctx.size) {
    l2.push(`${DIM}${fmtTokens(ctx.used)}/${fmtTokens(ctx.size)} ctx${R}`);
  }
} else {
  l2.push(`${GREY}context pending${R}`);
}

if (d.exceeds_200k_tokens) l2.push(`${RED}⚠ >200k${R}`);

const cost = d.cost?.total_cost_usd;
if (Number.isFinite(cost) && cost > 0) l2.push(`${DIM}$${cost.toFixed(2)}${R}`);

const dur = fmtDuration(d.cost?.total_duration_ms);
if (dur) l2.push(`${DIM}${dur}${R}`);

const added = d.cost?.total_lines_added, removed = d.cost?.total_lines_removed;
if (added || removed) l2.push(`${GREEN}+${added || 0}${R}${DIM}/${R}${RED}-${removed || 0}${R}`);

process.stdout.write(l1.join(`${GREY} · ${R}`) + '\n' + l2.join('  ') + '\n');
