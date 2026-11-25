// ============================================================================
// Run the live mirror contract check.
//
// The contract test is opt-in behind ROWNATIVE_CONTRACT_CHECK=1 because it
// talks to the network, and its own comment says to run it "e.g. on a
// schedule" — but nothing ran it at all, so #208's AC-3 had no way to fire.
// A node runner rather than an inline env assignment in the npm script: those
// are shell-specific and this repo is developed on Windows as well as CI.
// ============================================================================

import { spawn } from 'node:child_process';

// `landscape` runs the #762 landscape-source contract instead of the mirror's.
const CHECKS = {
  mirror: { file: 'src/__tests__/rownativeMirrorContract.test.ts', env: 'ROWNATIVE_CONTRACT_CHECK' },
  landscape: { file: 'src/__tests__/landscapeContract.test.ts', env: 'LANDSCAPE_CONTRACT_CHECK' },
};
const check = CHECKS[process.argv[2] ?? 'mirror'];
if (!check) {
  console.error(`unknown contract check: ${process.argv[2]} (expected ${Object.keys(CHECKS).join(' or ')})`);
  process.exit(2);
}

const child = spawn(
  'npx',
  ['vitest', 'run', check.file],
  {
    stdio: 'inherit',
    // shell: true so this resolves npx on Windows as well as POSIX without
    // hard-coding npx.cmd, which node refuses to spawn directly.
    shell: true,
    env: { ...process.env, [check.env]: '1' },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
