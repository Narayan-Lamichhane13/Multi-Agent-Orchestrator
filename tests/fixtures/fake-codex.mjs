// Stand-in for the real `codex exec`, driven by the FAKE_CODEX_MODE env var.
// Reads the prompt from stdin like the real CLI, then edits files in its cwd.
//
//   sprawl  — edits one allowed file, adds one allowed file, and touches three
//             out-of-scope files that the harness must revert.
//   hang    — applies one allowed edit, then goes silent forever (watchdog test).
import fs from 'node:fs';

const mode = process.env.FAKE_CODEX_MODE || 'sprawl';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', run);
process.stdin.on('error', run);
setTimeout(run, 1000); // in case stdin never closes

let done = false;
function run() {
  if (done) return;
  done = true;

  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync('src/allowed.txt', 'IN SCOPE: modified by codex\n');
  console.log(`fake-codex(${mode}) received ${prompt.length} chars`);
  console.log('Applying file change(s)');

  if (mode === 'sprawl') {
    fs.writeFileSync('src/newly-added.txt', 'IN SCOPE: new file\n');
    fs.writeFileSync('src/forbidden.txt', 'OUT OF SCOPE: must be reverted\n');
    fs.writeFileSync('sneaky-new-file.txt', 'OUT OF SCOPE: must be deleted\n');
    fs.mkdirSync('docs', { recursive: true });
    fs.writeFileSync('docs/notes.md', 'OUT OF SCOPE: must be reverted\n');
    process.exit(0);
  }

  if (mode === 'hang') {
    setInterval(() => {}, 1 << 30); // silent forever
  }
}
