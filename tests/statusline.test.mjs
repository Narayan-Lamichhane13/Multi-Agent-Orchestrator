// Tests for statusline/statusline.mjs — feeds Claude Code's session JSON on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUSLINE = path.join(HERE, '..', 'statusline', 'statusline.mjs');

function render(input) {
  return execFileSync(process.execPath, [STATUSLINE], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('renders model, context percentage and cost from the session payload', () => {
  const out = strip(render(JSON.stringify({
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    workspace: { current_dir: process.cwd() },
    context_window: { context_window_size: 200000, used_percentage: 42, current_usage: { input_tokens: 80000, output_tokens: 4000 } },
    cost: { total_cost_usd: 1.23, total_duration_ms: 600000 },
  })));
  assert.match(out, /◆ Opus/);
  assert.match(out, /42%/);
  assert.match(out, /84\.0k\/200\.0k ctx/);
  assert.match(out, /\$1\.23/);
  assert.match(out, /10m/);
});

test('tolerates a UTF-8 BOM and surrounding whitespace on stdin', () => {
  const out = strip(render('﻿  ' + JSON.stringify({ model: { display_name: 'Sonnet' } }) + '\n'));
  assert.match(out, /◆ Sonnet/);
});

test('degrades gracefully on null context fields and empty stdin', () => {
  const nulls = strip(render(JSON.stringify({
    model: { display_name: 'Sonnet' },
    context_window: { context_window_size: 200000, used_percentage: null, current_usage: null },
  })));
  assert.match(nulls, /--%/);

  const empty = strip(render(''));
  assert.match(empty, /◆ Claude/);
  assert.match(empty, /context pending/);
});

test('flags a session over the 200k boundary', () => {
  const out = strip(render(JSON.stringify({
    model: { display_name: 'Opus' },
    context_window: { context_window_size: 200000, used_percentage: 91 },
    exceeds_200k_tokens: true,
  })));
  assert.match(out, /91%/);
  assert.match(out, />200k/);
});
