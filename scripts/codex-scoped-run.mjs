#!/usr/bin/env node
/**
 * codex-scoped-run.mjs — scope-enforced Codex execution harness
 *
 * Claude scopes the work and reviews it; Codex (GPT) applies the edits inside a
 * mechanically-enforced file allowlist. Anything Codex touches outside the
 * allowlist is reverted before the result is returned, so it cannot sprawl.
 *
 * Runs on the public `codex exec` CLI (ChatGPT / OPENAI_API_KEY auth) with no
 * dependencies beyond Node and git — no bash, python or jq. Cross-platform,
 * including native Windows.
 *
 * Usage:
 *   node codex-scoped-run.mjs \
 *     --repo <path> \
 *     --allow "src/foo.ts" --allow "src/__tests__/**" \
 *     --prompt-file <file>            (or --prompt "text") \
 *     [--model gpt-6-astra] [--effort low|medium|high|xhigh] \
 *     [--mode auto|worktree|inplace] \
 *     [--verify-cmd "npm test"] \
 *     [--idle-timeout 180] [--max-runtime 1800] \
 *     [--sandbox workspace-write] [--cleanup-worktree] [--dry-run]
 *
 * Leave --model unset to use codex's own default — codex-cli 0.153+ defaults to
 * gpt-6-astra (Astra) automatically, so most invocations need no model flag at all.
 *
 * stdout: a single JSON result object (nothing else — safe to parse).
 * stderr: human-readable progress logs.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c } from './lib/ui.mjs';

const IS_WIN = process.platform === 'win32';

// --------------------------------------------------------------------------- //
// Logging (stderr only — stdout is reserved for the JSON result). Leveled so a
// skim of the log shows what mattered: grey for routine progress, yellow for
// watchdog action, green for a clean finish, red for a hard failure.
// --------------------------------------------------------------------------- //
const LEVEL_COLOR = { info: c.grey, watchdog: c.yellow, done: c.green, error: c.red };
function log(msg, level = 'info') {
  const paint = LEVEL_COLOR[level] || c.grey;
  console.error(paint('›') + ' ' + msg);
}

function die(msg, extra = {}) {
  // Emit a parseable error result so the caller always gets JSON.
  process.stdout.write(JSON.stringify({
    status: 'error', error: msg, inScopeChanged: [], outOfScopeReverted: [], ...extra,
  }, null, 2) + '\n');
  process.exit(2);
}

// --------------------------------------------------------------------------- //
// Argument parsing
// --------------------------------------------------------------------------- //
const opts = {
  repo: null,
  allow: [],
  prompt: null,
  promptFile: null,
  model: null,           // null => codex's own default (gpt-6-astra as of codex-cli 0.153+)
  effort: null,          // null => codex's own default
  mode: 'auto',
  verifyCmd: null,
  idleTimeout: 180,
  maxRuntime: 1800,
  sandbox: 'workspace-write',
  cleanupWorktree: false,
  dryRun: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) die(`Missing value for ${a}`);
    return argv[++i];
  };
  switch (a) {
    case '--repo':             opts.repo = next(); break;
    case '--allow':            opts.allow.push(next()); break;
    case '--prompt':           opts.prompt = next(); break;
    case '--prompt-file':      opts.promptFile = next(); break;
    case '--model':            opts.model = next(); break;
    case '--effort':           opts.effort = next(); break;
    case '--mode':             opts.mode = next(); break;
    case '--verify-cmd':       opts.verifyCmd = next(); break;
    case '--idle-timeout':     opts.idleTimeout = parseInt(next(), 10); break;
    case '--max-runtime':      opts.maxRuntime = parseInt(next(), 10); break;
    case '--sandbox':          opts.sandbox = next(); break;
    case '--cleanup-worktree': opts.cleanupWorktree = true; break;
    case '--dry-run':          opts.dryRun = true; break;
    case '-h':
    case '--help':
      console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    default: die(`Unknown argument: ${a}`);
  }
}

// --------------------------------------------------------------------------- //
// Validation
// --------------------------------------------------------------------------- //
if (!opts.repo) die('--repo is required');
opts.repo = path.resolve(opts.repo);
if (!fs.existsSync(opts.repo)) die(`--repo does not exist: ${opts.repo}`);
if (opts.allow.length === 0) {
  die('At least one --allow pattern is required. Running Codex unguarded is not supported — ' +
      'the allowlist is what makes scope enforcement mechanical.');
}
if (!opts.prompt && !opts.promptFile) die('--prompt or --prompt-file is required');
if (opts.promptFile && !fs.existsSync(opts.promptFile)) die(`--prompt-file not found: ${opts.promptFile}`);
if (!['auto', 'worktree', 'inplace'].includes(opts.mode)) die(`--mode must be auto|worktree|inplace, got: ${opts.mode}`);

const promptText = opts.promptFile ? fs.readFileSync(opts.promptFile, 'utf8') : opts.prompt;
if (!promptText.trim()) die('Prompt is empty');

// --------------------------------------------------------------------------- //
// Git helpers
// --------------------------------------------------------------------------- //
/**
 * Run git and return stdout.
 *
 * `trim` must be false for `status --porcelain`: its lines begin with a
 * two-column status field (" M path"), and trimming the buffer would eat the
 * leading space of the FIRST line, corrupting that path — which silently breaks
 * the revert for whichever file happens to sort first.
 */
function git(cwd, args, { allowFail = false, trim = true } = {}) {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return trim ? out.trim() : out;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

function isGitRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
}

/** Changed + untracked files, repo-relative, forward slashes. */
function changedFiles(cwd) {
  const out = git(cwd, ['status', '--porcelain'], { trim: false }) || '';
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3);  // strip the 2-char status field + separating space
    if (p.includes(' -> ')) p = p.slice(p.lastIndexOf(' -> ') + 4); // rename: keep the new path
    if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);    // git-quoted path
    files.push(p.replace(/\\/g, '/'));
  }
  return files;
}

function statusHash(cwd) {
  return createHash('sha1').update(git(cwd, ['status', '--porcelain'], { allowFail: true }) || '').digest('hex');
}

// --------------------------------------------------------------------------- //
// Allowlist matching
//
// Supports the glob subset the orchestrator actually uses:
//   src/client.ts     exact file
//   src/*.ts          one path segment
//   src/**            everything beneath src/
//   src/**/*.test.ts  any depth, then a filename pattern
//   src/              trailing slash == src/**
// --------------------------------------------------------------------------- //
function globToRegExp(pattern) {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';           // "src/" is shorthand for "src/**"
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; }  // "a/**/b" also matches "a/b"
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const allowRegexes = opts.allow.map(globToRegExp);
const isAllowed = (file) => allowRegexes.some((re) => re.test(file));

// --------------------------------------------------------------------------- //
// Mode detection
// --------------------------------------------------------------------------- //
if (!isGitRepo(opts.repo)) {
  die(`--repo is not a git repository: ${opts.repo}. The harness needs git to revert out-of-scope edits.`);
}
const repoRoot = git(opts.repo, ['rev-parse', '--show-toplevel']).replace(/\\/g, '/');

let mode = opts.mode;
if (mode === 'auto') {
  // Worktree isolation is the safe default. Fall back to inplace when the tree
  // is dirty (a worktree built from HEAD would silently omit the user's WIP).
  const dirty = changedFiles(repoRoot).length > 0;
  mode = dirty ? 'inplace' : 'worktree';
  log(`mode=auto resolved to '${mode}'${dirty ? ' (working tree is dirty)' : ''}`);
}

// --------------------------------------------------------------------------- //
// Build the codex argv
// --------------------------------------------------------------------------- //
function buildCodexArgs() {
  const args = ['exec'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push('--sandbox', opts.sandbox);
  args.push('--skip-git-repo-check');
  args.push('-');                      // read the prompt from stdin
  return args;
}

// --------------------------------------------------------------------------- //
// Run Codex with a watchdog
// --------------------------------------------------------------------------- //
function killTree(pid) {
  try {
    if (IS_WIN) execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

async function runCodex(workdir) {
  const logFile = path.join(os.tmpdir(), `codex-run-${Date.now()}-${process.pid}.log`);
  const logFd = fs.openSync(logFile, 'a');
  const args = buildCodexArgs();

  log(`running: codex ${args.join(' ')}`);
  log(`cwd: ${workdir}`);
  log(`watchdog: idle=${opts.idleTimeout}s max-runtime=${opts.maxRuntime > 0 ? opts.maxRuntime + 's' : 'unlimited'}`);

  const child = spawn('codex', args, {
    cwd: workdir,
    stdio: ['pipe', logFd, logFd],
    detached: !IS_WIN,           // own process group on posix so we can kill the tree
    shell: IS_WIN,               // resolve codex.cmd shim on Windows
  });

  child.stdin.write(promptText);
  child.stdin.end();

  let status = 'ok';
  let exitCode = null;
  let exited = false;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  child.on('error', (err) => { exited = true; exitCode = -1; log(`spawn error: ${err.message}`, 'error'); });

  const start = Date.now();
  let lastActivity = start;
  let lastSize = 0;
  let lastHash = statusHash(workdir);
  const pollMs = Math.max(1000, Math.min(15000, (opts.idleTimeout * 1000) / 2));

  while (!exited) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (exited) break;
    const now = Date.now();

    if (opts.maxRuntime > 0 && now - start >= opts.maxRuntime * 1000) {
      log(`WATCHDOG: max-runtime exceeded (${Math.round((now - start) / 1000)}s). Killing codex.`, 'watchdog');
      status = 'stalled';
      killTree(child.pid);
      break;
    }

    // Liveness: the log growing OR the working tree changing means it is working.
    const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    const hash = statusHash(workdir);
    if (size !== lastSize || hash !== lastHash) {
      lastActivity = now;
      lastSize = size;
      lastHash = hash;
    }

    if (now - lastActivity >= opts.idleTimeout * 1000) {
      log(`WATCHDOG: idle-timeout exceeded (${Math.round((now - lastActivity) / 1000)}s with no output or file changes). Killing codex.`, 'watchdog');
      status = 'stalled';
      killTree(child.pid);
      break;
    }
  }

  // Let a killed child settle so its writes land before we read the log.
  if (status === 'stalled') await new Promise((r) => setTimeout(r, 1500));
  try { fs.closeSync(logFd); } catch { /* noop */ }

  const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const tail = raw.split('\n').slice(-40).join('\n');
  try { fs.unlinkSync(logFile); } catch { /* noop */ }

  log(`codex finished: status=${status} exitCode=${exitCode}`, status === 'ok' ? 'done' : 'watchdog');
  return { status, exitCode, tail };
}

// --------------------------------------------------------------------------- //
// Scope enforcement
// --------------------------------------------------------------------------- //

/**
 * Record the content of every already-modified file before Codex runs.
 *
 * This is what makes `inplace` mode safe. Without it, any uncommitted work the
 * user already had in progress would look like out-of-scope sprawl and get
 * reverted — destroying their changes. With it, "out of scope" means "Codex
 * touched it", not merely "it differs from HEAD".
 *
 * In worktree mode the snapshot is empty (a fresh worktree matches HEAD), so
 * this costs nothing there.
 */
function snapshotDirty(workdir) {
  const snap = new Map();
  for (const f of changedFiles(workdir)) {
    try { snap.set(f, fs.readFileSync(path.join(workdir, f))); }
    catch { snap.set(f, null); }   // deleted at baseline
  }
  if (snap.size) log(`baseline: ${snap.size} file(s) already modified before the run`);
  return snap;
}

/** Revert every change Codex made outside the allowlist. */
function enforceAllowlist(workdir, baseline) {
  const inScope = [];
  const outOfScope = [];
  const preExisting = [];

  const readNow = (abs) => { try { return fs.readFileSync(abs); } catch { return null; } };

  for (const file of changedFiles(workdir)) {
    if (isAllowed(file)) {
      inScope.push(file);
      continue;
    }

    const abs = path.join(workdir, file);

    if (baseline.has(file)) {
      // The user had already modified this file before Codex ran.
      const before = baseline.get(file);
      const now = readNow(abs);
      const unchanged = (before === null && now === null) ||
                        (before !== null && now !== null && before.equals(now));
      if (unchanged) {
        preExisting.push(file);   // the user's own work, untouched by Codex — leave it
        continue;
      }
      // Codex modified it: restore the USER's version, not HEAD.
      if (before === null) {
        try { fs.rmSync(abs, { force: true }); } catch { /* noop */ }
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, before);
      }
      outOfScope.push(file);
      continue;
    }

    // Clean at baseline, so the change is entirely Codex's — revert to HEAD.
    outOfScope.push(file);
    const tracked = git(workdir, ['ls-files', '--error-unmatch', file], { allowFail: true }) !== null;
    if (tracked) {
      git(workdir, ['checkout', 'HEAD', '--', file], { allowFail: true });
    } else {
      try { fs.rmSync(abs, { force: true, recursive: true }); } catch { /* noop */ }
    }
  }

  log(`in-scope: ${inScope.length}, out-of-scope reverted: ${outOfScope.length}, pre-existing left alone: ${preExisting.length}`);
  if (outOfScope.length) log(`reverted: ${outOfScope.join(', ')}`);
  return { inScope, outOfScope, preExisting };
}

/** Produce a patch of the surviving in-scope changes so it can be applied to the main repo. */
function writePatch(workdir, inScope) {
  if (!inScope.length) return null;
  git(workdir, ['add', '-N', '--', ...inScope], { allowFail: true }); // make untracked files visible to diff
  const diff = git(workdir, ['diff', '--binary', '--', ...inScope], { allowFail: true });
  if (!diff) return null;
  const patchFile = path.join(os.tmpdir(), `codex-scoped-${Date.now()}.patch`);
  fs.writeFileSync(patchFile, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
  return patchFile;
}

function runVerify(workdir) {
  if (!opts.verifyCmd) return { ran: false, exitCode: null, tail: '' };
  log(`verify: ${opts.verifyCmd}`);
  try {
    const out = execFileSync(opts.verifyCmd, {
      cwd: workdir, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    return { ran: true, exitCode: 0, tail: out.split('\n').slice(-40).join('\n') };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return { ran: true, exitCode: err.status ?? 1, tail: out.split('\n').slice(-40).join('\n') };
  }
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //
const baselineHead = git(repoRoot, ['rev-parse', 'HEAD'], { allowFail: true }) || 'UNBORN';

if (opts.dryRun) {
  const cmd = `codex ${buildCodexArgs().join(' ')}`;
  log(`${c.cyan('◆ dry-run')} — would run: ${cmd}`, 'info');
  process.stdout.write(JSON.stringify({
    status: 'dry-run',
    mode,
    repo: repoRoot,
    command: cmd,
    promptChars: promptText.length,
    allow: opts.allow,
    baselineHead,
  }, null, 2) + '\n');
  process.exit(0);
}

let worktree = null;
let workdir = repoRoot;

if (mode === 'worktree') {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wt-'));
  fs.rmSync(worktree, { recursive: true, force: true }); // git wants to create it itself
  log(`creating worktree at ${worktree}`);
  try {
    git(repoRoot, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  } catch (err) {
    die(`Failed to create worktree: ${err.message}`);
  }
  workdir = worktree;
}

let result;
try {
  // Snapshot BEFORE the run so pre-existing uncommitted work is never mistaken
  // for Codex sprawl (matters in inplace mode; a no-op in a fresh worktree).
  const baseline = snapshotDirty(workdir);
  const codexRun = await runCodex(workdir);
  const scope = enforceAllowlist(workdir, baseline);
  const patchFile = mode === 'worktree' ? writePatch(workdir, scope.inScope) : null;
  const verify = runVerify(workdir);
  // Scope the stat to the in-scope files so it reports Codex's change alone,
  // not any unrelated work already in the tree (inplace mode).
  const diffStat = scope.inScope.length
    ? (git(workdir, ['diff', '--stat', 'HEAD', '--', ...scope.inScope], { allowFail: true }) || '')
    : '';

  result = {
    status: codexRun.status,
    mode,
    model: opts.model || '(codex default)',
    effort: opts.effort || '(codex default)',
    repo: repoRoot,
    worktree,
    baselineHead,
    inScopeChanged: scope.inScope,
    outOfScopeReverted: scope.outOfScope,
    preExistingUnchanged: scope.preExisting,
    diffStat,
    patchFile,
    applyCommand: patchFile ? `git -C "${repoRoot}" apply "${patchFile}"` : null,
    verify,
    codexExitCode: codexRun.exitCode,
    idleTimeoutSec: opts.idleTimeout,
    maxRuntimeSec: opts.maxRuntime,
    logTail: codexRun.status === 'ok' ? '' : codexRun.tail,
    notes: codexRun.status === 'stalled' && scope.inScope.length > 0
      ? 'Watchdog killed a quiet phase AFTER edits landed. Per the pipeline contract this counts as DELIVERED — review the diff, do not blindly re-run.'
      : '',
  };
} catch (err) {
  result = {
    status: 'error', error: err.message, mode, repo: repoRoot, worktree,
    inScopeChanged: [], outOfScopeReverted: [],
  };
}

if (worktree && opts.cleanupWorktree) {
  log(`removing worktree ${worktree}`);
  git(repoRoot, ['worktree', 'remove', '--force', worktree], { allowFail: true });
  result.worktree = null;
  result.worktreeRemoved = true;
} else if (worktree) {
  result.cleanupCommand = `git -C "${repoRoot}" worktree remove --force "${worktree}"`;
}

// One-line human summary on stderr — stdout stays pure JSON for the caller.
const STATUS_LINE = {
  ok: () => log(`${c.green('✔ done')} — ${result.inScopeChanged?.length || 0} file(s) changed, ${result.outOfScopeReverted?.length || 0} reverted`, 'done'),
  stalled: () => log(`${c.yellow('! stalled')} — ${result.inScopeChanged?.length || 0} file(s) changed before the watchdog stopped it`, 'watchdog'),
  error: () => log(`${c.red('✘ error')} — ${result.error}`, 'error'),
};
(STATUS_LINE[result.status] || (() => {}))();

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.status === 'error' ? 2 : 0);
