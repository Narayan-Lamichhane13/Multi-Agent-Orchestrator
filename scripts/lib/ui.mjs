/**
 * ui.mjs — tiny zero-dependency terminal UI kit shared by the pipeline's CLI
 * scripts (codex-doctor.mjs, codex-scoped-run.mjs's stderr log stream).
 *
 * Deliberately dependency-free: these run as hooks/subagent commands, so they
 * must work with nothing but the Node stdlib. Follows clig.dev conventions —
 * respects NO_COLOR and non-TTY output, degrades to plain text automatically.
 *
 * https://clig.dev/#output
 */

import process from 'node:process';

// --------------------------------------------------------------------------- //
// Color support detection
// --------------------------------------------------------------------------- //
function detectColor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

const colorEnabled = detectColor(process.stderr);

function paint(code) {
  return colorEnabled ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s);
}

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  grey: paint('90'),
};

// --------------------------------------------------------------------------- //
// Layout primitives
// --------------------------------------------------------------------------- //
const WIDTH = Math.min(Math.max(process.stderr.columns || 80, 40), 100);

/** Section header: a bold label over a full-width rule. Robust to any terminal width — no boxes to misalign. */
export function header(title) {
  const line = '─'.repeat(WIDTH);
  return `\n${c.bold(c.cyan(title))}\n${c.grey(line)}`;
}

/** Thin full-width divider. */
export function rule() {
  return c.grey('─'.repeat(WIDTH));
}

const ICONS = {
  ok: c.green('✔'),
  fail: c.red('✘'),
  warn: c.yellow('!'),
  info: c.grey('·'),
};

/**
 * One checklist line: `✔ label` with an optional dim hint on the next line,
 * indented under the icon so multi-line output still reads as one item.
 */
export function item(status, label, hint) {
  const icon = ICONS[status] ?? ICONS.info;
  let out = `${icon} ${label}`;
  if (hint) out += `\n  ${c.dim('→ ' + hint)}`;
  return out;
}

/** Aligned label/value row, e.g. for a key-facts block. */
export function kv(label, value, padTo = 14) {
  return `  ${c.dim(label.padEnd(padTo))} ${value}`;
}

/**
 * Tally line: "3 passed · 1 warning · 2 failed", each segment colored and
 * omitted when zero so a clean run reads as just "5 passed".
 */
export function summary(counts) {
  const parts = [];
  if (counts.ok) parts.push(c.green(`${counts.ok} passed`));
  if (counts.warn) parts.push(c.yellow(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`));
  if (counts.fail) parts.push(c.red(`${counts.fail} failed`));
  return parts.join(c.grey(' · ')) || c.dim('nothing checked');
}

/** A dim, indented code/command block for "run this next" callouts. */
export function code(text) {
  return text.split('\n').map((l) => c.dim('  ' + l)).join('\n');
}
