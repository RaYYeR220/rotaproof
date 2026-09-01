#!/usr/bin/env node
/**
 * Re-derive a receipt and compare it.
 *
 * A receipt says "these rules produced this answer". That is only worth anything if a
 * third party can run it again and get the same thing, so this script does exactly that:
 * it re-solves from the recorded model and checks the hashes still match.
 *
 *   node scripts/verify-receipt.mjs                      # check the committed receipts
 *   node scripts/verify-receipt.mjs path/to/receipt.json # check one exported from the app
 *   node scripts/verify-receipt.mjs --write              # regenerate the committed ones
 *
 * Exits non-zero on any mismatch, so it is usable as a check rather than a report.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import highsLoader from 'highs';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// The packages ship raw TypeScript, so they are loaded through jiti rather than built.
const jiti = createJiti(import.meta.url);
const core = await jiti.import(resolve(root, 'packages/core/src/index.ts'));

const { HighsBackend, canonicalize, fridayConflict, seedRoster, solveRoster } = core;

const RECEIPTS_PATH = resolve(root, 'receipts/seed.json');

/** The scenarios that get a committed receipt. Both are what the README quotes. */
const SCENARIOS = [
  {
    id: 'seed-week',
    description: 'The seeded ten-person week, solved to proven optimality.',
    model: () => seedRoster(),
  },
  {
    id: 'friday-conflict',
    description: 'The same week with one Friday granted off, which cannot be satisfied.',
    model: () => {
      const model = seedRoster();
      model.constraints.push(fridayConflict());
      return model;
    },
  },
];

const args = process.argv.slice(2);
const write = args.includes('--write');
const explicit = args.find((a) => !a.startsWith('--'));

const backend = await HighsBackend.create(highsLoader);

/** Everything about a result that must be stable, excluding wall-clock timings. */
function fingerprint(model, result) {
  const out = {
    modelHash: result.receipt.modelHash,
    canonicalLength: canonicalize(model).length,
    status: result.receipt.status,
    solverVersion: result.receipt.solverVersion,
  };
  if (result.receipt.objective !== undefined) {
    out.objective = Number(result.receipt.objective.toFixed(6));
  }
  if (result.receipt.scheduleHash) out.scheduleHash = result.receipt.scheduleHash;
  if (result.receipt.conflictHash) out.conflictHash = result.receipt.conflictHash;
  if (result.schedule) out.assignments = result.schedule.length;
  if (result.conflict) out.conflictingRules = [...result.conflict.constraintIds].sort();
  return out;
}

async function runScenario(scenario) {
  const model = scenario.model();
  const started = Date.now();
  const result = await solveRoster(model, backend);
  return {
    id: scenario.id,
    description: scenario.description,
    ...fingerprint(model, result),
    // Reported but never compared — timings are properties of the machine, not the model.
    observedMs: Date.now() - started,
  };
}

function compare(expected, actual) {
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'observedMs' || key === 'description') continue;
    const got = actual[key];
    const same = Array.isArray(value)
      ? JSON.stringify(value) === JSON.stringify(got)
      : value === got;
    if (!same) problems.push(`  ${key}\n    expected ${JSON.stringify(value)}\n    got      ${JSON.stringify(got)}`);
  }
  return problems;
}

if (explicit) {
  // A receipt exported from the running app: re-solve its scenario and compare hashes.
  const supplied = JSON.parse(readFileSync(explicit, 'utf8'));
  const scenario = SCENARIOS.find((s) => s.id === supplied.id);
  if (!scenario) {
    console.error(
      `Receipt names scenario "${supplied.id}", which this script does not know how to rebuild.\n` +
        `Known scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}.`,
    );
    process.exit(2);
  }
  const actual = await runScenario(scenario);
  const problems = compare(supplied, actual);
  if (problems.length > 0) {
    console.error(`MISMATCH for ${supplied.id}:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`OK  ${supplied.id} reproduces exactly (${actual.observedMs} ms).`);
  process.exit(0);
}

const results = [];
for (const scenario of SCENARIOS) results.push(await runScenario(scenario));

if (write) {
  writeFileSync(RECEIPTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Wrote ${results.length} receipts to receipts/seed.json`);
  process.exit(0);
}

let failed = false;
const expected = JSON.parse(readFileSync(RECEIPTS_PATH, 'utf8'));

for (const actual of results) {
  const golden = expected.find((r) => r.id === actual.id);
  if (!golden) {
    console.error(`MISSING  no committed receipt for "${actual.id}"`);
    failed = true;
    continue;
  }
  const problems = compare(golden, actual);
  if (problems.length > 0) {
    console.error(`MISMATCH  ${actual.id}\n${problems.join('\n')}`);
    failed = true;
  } else {
    const detail =
      actual.status === 'infeasible'
        ? `${actual.conflictingRules.length} conflicting rules`
        : `objective ${actual.objective}, ${actual.assignments} assignments`;
    console.log(`OK  ${actual.id}: ${actual.status}, ${detail} (${actual.observedMs} ms)`);
  }
}

if (failed) {
  console.error(
    '\nA receipt did not reproduce. Either the model changed — in which case run with --write\n' +
      'and commit the new receipts as part of that change — or something is wrong.',
  );
  process.exit(1);
}

console.log('\nAll receipts reproduce.');
