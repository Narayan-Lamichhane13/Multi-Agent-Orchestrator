// End-to-end tests for codex-scoped-run.mjs using a fake `codex` on PATH.
// Runs with Node's built-in runner:  node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, '..', 'scripts', 'codex-scoped-run.mjs');
const FAKE = path.join(HERE, 'fixtures', 'fake-codex.mjs');
const IS_WIN = process.platform === 'win32';

let fakeBin;

before(() => {
  // Put a fake `codex` first on PATH. Windows resolves codex.cmd; POSIX runs the shell shim.
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-bin-'));
  if (IS_WIN) {
    fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), `@echo off\r\nnode "${FAKE}" %*\r\n`);
  } else {
    const shim = path.join(fakeBin, 'codex');
    fs.writeFileSync(shim, `#!/bin/sh\nexec node "${FAKE}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
});

after(() => { fs.rmSync(fakeBin, { recursive: true, force: true }); });

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Fresh git repo with a few committed files. */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-repo-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'src', 'allowed.txt'), 'original allowed\n');
  fs.writeFileSync(path.join(repo, 'src', 'forbidden.txt'), 'original forbidden\n');
  fs.writeFileSync(path.join(repo, 'docs', 'notes.md'), 'original notes\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/** Run the harness with the fake codex on PATH; returns parsed JSON from stdout. */
function run(args, { mode = 'sprawl', extraEnv = {} } = {}) {
  const env = { ...process.env, FAKE_CODEX_MODE: mode, PATH: fakeBin + path.delimiter + process.env.PATH, ...extraEnv };
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [HARNESS, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    stdout = err.stdout; // exit code 2 on status=error still emits JSON
  }
  return JSON.parse(stdout);
}

function cleanup(result, repo) {
  if (result.worktree) { try { git(repo, 'worktree', 'remove', '--force', result.worktree); } catch { /* noop */ } }
  if (result.patchFile) { try { fs.unlinkSync(result.patchFile); } catch { /* noop */ } }
  fs.rmSync(repo, { recursive: true, force: true });
}

test('dry-run reports the codex command without running anything', () => {
  const repo = makeRepo();
  const r = run(['--repo', repo, '--allow', 'src/allowed.txt', '--prompt', 'x', '--dry-run']);
  assert.equal(r.status, 'dry-run');
  assert.match(r.command, /^codex exec /);
  assert.match(r.command, /--sandbox workspace-write/);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'repo untouched');
  cleanup(r, repo);
});

test('worktree mode: allowlist is enforced mechanically', () => {
  const repo = makeRepo();
  const r = run(['--repo', repo, '--allow', 'src/allowed.txt', '--allow', 'src/newly-*.txt', '--prompt', 'go']);

  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'worktree');
  assert.deepEqual([...r.inScopeChanged].sort(), ['src/allowed.txt', 'src/newly-added.txt']);
  // docs/notes.md sorts first in `git status`; guards against the leading-space trim bug.
  assert.deepEqual([...r.outOfScopeReverted].sort(), ['docs/notes.md', 'sneaky-new-file.txt', 'src/forbidden.txt']);

  const wt = r.worktree;
  assert.match(fs.readFileSync(path.join(wt, 'src', 'allowed.txt'), 'utf8'), /IN SCOPE/);
  assert.match(fs.readFileSync(path.join(wt, 'src', 'forbidden.txt'), 'utf8'), /original forbidden/);
  assert.match(fs.readFileSync(path.join(wt, 'docs', 'notes.md'), 'utf8'), /original notes/);
  assert.equal(fs.existsSync(path.join(wt, 'sneaky-new-file.txt')), false);

  assert.equal(git(repo, 'status', '--porcelain'), '', 'main repo untouched');
  assert.ok(r.patchFile && fs.existsSync(r.patchFile), 'patch produced');
  assert.doesNotMatch(r.diffStat, /docs\/notes\.md/, 'diffStat covers only in-scope files');

  // The patch applies cleanly to the main repo and carries only the in-scope edits.
  git(repo, 'apply', r.patchFile);
  assert.match(fs.readFileSync(path.join(repo, 'src', 'allowed.txt'), 'utf8'), /IN SCOPE/);
  assert.ok(fs.existsSync(path.join(repo, 'src', 'newly-added.txt')));
  assert.match(fs.readFileSync(path.join(repo, 'src', 'forbidden.txt'), 'utf8'), /original forbidden/);
  cleanup(r, repo);
});

test('watchdog: a stall after edits landed is reported as delivered', () => {
  const repo = makeRepo();
  const t0 = Date.now();
  const r = run(['--repo', repo, '--allow', 'src/allowed.txt', '--prompt', 'go', '--idle-timeout', '3', '--max-runtime', '60'], { mode: 'hang' });
  const elapsed = (Date.now() - t0) / 1000;

  assert.equal(r.status, 'stalled');
  assert.deepEqual(r.inScopeChanged, ['src/allowed.txt']);
  assert.match(r.notes, /DELIVERED/);
  assert.match(r.logTail, /Applying file change/);
  assert.ok(elapsed < 30, `killed near the idle timeout (took ${elapsed}s)`);
  cleanup(r, repo);
});

test('inplace mode: pre-existing uncommitted work is never reverted', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'uncommitted work in progress\n'); // dirty → auto picks inplace
  const r = run(['--repo', repo, '--allow', 'src/allowed.txt', '--prompt', 'go']);

  assert.equal(r.mode, 'inplace');
  assert.equal(r.worktree, null);
  assert.match(fs.readFileSync(path.join(repo, 'src', 'allowed.txt'), 'utf8'), /IN SCOPE/);
  assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /uncommitted work in progress/, 'WIP preserved');
  assert.ok(r.preExistingUnchanged.includes('README.md'));
  assert.ok(!r.outOfScopeReverted.includes('README.md'));
  assert.ok(r.outOfScopeReverted.includes('src/forbidden.txt'), 'codex sprawl still reverted');
  cleanup(r, repo);
});

test('guard rails: refuses to run without an allowlist or outside a git repo', () => {
  const repo = makeRepo();
  const noAllow = run(['--repo', repo, '--prompt', 'x']);
  assert.equal(noAllow.status, 'error');
  assert.match(noAllow.error, /--allow/);

  // GIT_CEILING_DIRECTORIES keeps git from discovering a repo ABOVE the temp dir
  // (e.g. when a user's home directory is itself a git repo and %TEMP% lives inside it).
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
  const noGit = run(['--repo', notRepo, '--allow', 'a', '--prompt', 'x'],
    { extraEnv: { GIT_CEILING_DIRECTORIES: path.dirname(notRepo) } });
  assert.equal(noGit.status, 'error');
  assert.match(noGit.error, /git/);

  fs.rmSync(notRepo, { recursive: true, force: true });
  cleanup({}, repo);
});
