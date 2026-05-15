// Run the vitest suite in two sequential shards, each in a fresh Node
// process, with automatic retry on the Windows "Worker exited unexpectedly"
// crash (STATUS_STACK_BUFFER_OVERRUN / 0xC0000409).
//
// Diagnosis: vitest+singleFork+libsodium-wrappers-sumo on Windows hits a
// probabilistic worker crash. The position is random — sometimes after
// 1 file, sometimes after 30. Reproduces at ~30% rate per invocation
// regardless of pool (forks vs threads), heap size, or shard count.
// The same suite is stable on macOS/Linux CI. The runtime symptom is
// always a parent-process "Worker exited unexpectedly" with no worker
// stack trace, which means tinypool sees its child die without a clean
// exit — consistent with Windows /GS or an external process (Defender,
// EDR) terminating the child.
//
// Fix that actually works: retry the failed shard up to MAX_RETRIES
// times. Each retry is a brand-new Node invocation; the probability that
// all three sequential invocations crash on the same shard at the same
// random point is (~0.3)^3 ≈ 3%. Within a shard, tests still run in
// singleFork so DB-state assumptions hold; each test file's beforeAll
// resets the DB via resetTestDb so retries are safe.
//
// CI on non-Windows can use `yarn test:single` for a single direct
// vitest run; locally `yarn test` routes through this script.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoServerDir = path.resolve(__dirname, '..');

// Locate the workspace's vitest binary at the hoisted repo-root node_modules.
// On Windows the actual file is `.cmd`, elsewhere it's a POSIX shebang script.
// We resolve both candidates and pick whichever exists so this script works
// without shell-detection logic.
import { existsSync } from 'node:fs';
const repoRoot = path.resolve(repoServerDir, '..', '..');
const vitestBinCandidates = [
  path.join(repoRoot, 'node_modules', '.bin', 'vitest.cmd'),
  path.join(repoRoot, 'node_modules', '.bin', 'vitest'),
];
const vitestBin = vitestBinCandidates.find(existsSync);
if (!vitestBin) {
  process.stderr.write(
    `[test-sharded] could not find vitest binary under ${repoRoot}/node_modules/.bin\n`,
  );
  process.exit(2);
}

function runShard(shardSpec) {
  return new Promise((resolve, reject) => {
    // Direct binary execution — no shell, no PATH lookup. `.cmd` on Windows
    // requires shell:true since cmd.exe is the interpreter; the POSIX
    // shebang script runs directly. Args are statically defined, no
    // injection surface even with shell:true.
    const isWindowsCmd = vitestBin.endsWith('.cmd');
    const child = spawn(
      vitestBin,
      ['run', '--shard', shardSpec, '--reporter', 'basic'],
      {
        cwd: repoServerDir,
        stdio: 'inherit',
        shell: isWindowsCmd,
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const shards = ['1/2', '2/2'];
const MAX_RETRIES = 2;
let failed = false;
for (const shard of shards) {
  let lastCode = 1;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const label = attempt === 0 ? `shard ${shard}` : `shard ${shard} (retry ${attempt}/${MAX_RETRIES})`;
    process.stdout.write(`\n=== ${label} ===\n`);
    lastCode = await runShard(shard);
    if (lastCode === 0) break;
    // Don't auto-retry on a "tests legitimately failed" exit. vitest returns
    // 1 in both cases (test fail + worker crash), so we can't distinguish
    // perfectly without scraping stdout. Pragmatic call: always retry — a
    // genuine test failure will reproduce on the retry and the operator
    // sees the failure twice (harmless), while the Windows crash usually
    // does not reproduce. The retry budget caps the cost.
    process.stderr.write(`[test-sharded] ${label} exited with code ${lastCode}\n`);
  }
  if (lastCode !== 0) {
    failed = true;
    process.stderr.write(
      `[test-sharded] shard ${shard} failed after ${MAX_RETRIES + 1} attempts (last code ${lastCode})\n`,
    );
    // Keep going so the operator sees both shards' status.
  }
}

process.exit(failed ? 1 : 0);
