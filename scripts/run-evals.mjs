#!/usr/bin/env node
/**
 * Runs both eval suites against a live page, deterministically.
 *
 *   pnpm evals                                   # against http://localhost:3000
 *   pnpm evals -- --url https://rotaproof.vercel.app
 *
 * `smoke` mode executes the expected calls straight against the page, so it needs no
 * model and no API key and is safe in CI. It proves the tools exist and accept those
 * arguments; it says nothing about whether a model would have chosen them. Measuring that
 * needs `webmcp-evals browser`, which does need a model.
 *
 * Both suites are run against `?reset=1`, because the roster lives in IndexedDB and the
 * runner opens a fresh page per case against a shared profile — without a reset, case
 * three would inherit whatever case two did.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const base = (urlIndex >= 0 ? args[urlIndex + 1] : process.env.ROTAPROOF_URL || 'http://localhost:3210').replace(/\/$/, '');

const SUITES = [
  { name: 'manager', file: 'evals/manager.json', path: '/?reset=1' },
  { name: 'staff', file: 'evals/staff.json', path: '/staff?reset=1' },
];

let failed = false;

for (const suite of SUITES) {
  console.log(`\n──── ${suite.name} ────────────────────────────────────────────`);
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'webmcp-evals',
      'smoke',
      '-u',
      `${base}${suite.path}`,
      '-e',
      resolve(root, suite.file),
      '-v',
      // The tool defaults to chrome-canary, which most machines do not have.
      '--chrome-channel',
      'chrome',
    ],
    { cwd: root, stdio: 'inherit', shell: false },
  );

  if (result.status !== 0) failed = true;
}

if (failed) {
  console.error('\nAt least one suite failed. Is the app running, and is Chrome 149+ installed?');
  process.exit(1);
}

console.log('\nBoth suites passed.');
