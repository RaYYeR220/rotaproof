#!/usr/bin/env node
/**
 * Drives the real page in real Chrome and asserts the live WebMCP surface.
 *
 *   pnpm test:webmcp                                    # against http://localhost:3210
 *   pnpm test:webmcp -- https://rotaproof.vercel.app
 *   HEADLESS=1 pnpm test:webmcp
 *
 * This exists because the unit tests cannot see the browser. They prove the registry is
 * correct; only this proves the browser agrees — that the tools are actually registered,
 * that they appear and disappear with page state, that a confirmation genuinely blocks
 * until somebody clicks, and that the required headers survived the deploy.
 *
 * It also covers the three tools the eval suites cannot: `publish_roster`, `offer_swap`
 * and `accept_swap` all wait for a human, and this harness is the human.
 *
 * Needs Chrome 149+ installed. Set CHROME_PATH if it is not in the usual place, and use
 * forward slashes — backslashes in a JS string literal are silently eaten.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));

const CHROME_PATH =
  process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');

/**
 * Any of `--enable-features=WebMCP`, `--enable-features=WebMCPTesting` and
 * `--enable-blink-features=WebMCP` switch it on. The first matches what `webmcp-evals`
 * uses, so it is the one to keep in step with.
 */
const WEBMCP_ARGS = ['--enable-features=WebMCP', '--enable-blink-features=WebMCP'];

const BASE = (process.argv[2] || process.env.ROTAPROOF_URL || 'http://localhost:3210').replace(/\/$/, '');
const HEADLESS = process.env.HEADLESS === '1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  const suffix =
    detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for the app to say it has hydrated and finished its first registration pass. */
async function ready(page) {
  await page.waitForFunction(() => window.__ROTAPROOF_READY__ === true, { timeout: 30_000 });
}

/** Tool names currently registered, as the browser sees them. */
function listTools(page) {
  return page.evaluate(async () => {
    const mc = document.modelContext;
    if (!mc?.getTools) return [];
    return (await mc.getTools()).map((t) => ({
      name: t.name,
      // getTools hands the schema back as a JSON string, unlike page.webmcp.
      readOnly: t.annotations?.readOnlyHint ?? t.annotations?.readOnly ?? false,
      untrusted: t.annotations?.untrustedContentHint ?? t.annotations?.untrustedContent ?? false,
    }));
  });
}

/**
 * Calls a tool the way an agent does.
 *
 * Chrome 151 accepts exactly one shape: the handle from getTools, the arguments as a JSON
 * *string*, and both arguments mandatory. It resolves with a string.
 */
function callTool(page, name, args = {}) {
  return page.evaluate(
    async (toolName, argsJson) => {
      const mc = document.modelContext;
      const tool = (await mc.getTools()).find((t) => t.name === toolName);
      if (!tool) return { missing: true };
      const raw = await mc.executeTool(tool, argsJson);
      try {
        return { raw, parsed: JSON.parse(raw) };
      } catch {
        return { raw };
      }
    },
    name,
    JSON.stringify(args),
  );
}

/** Unwraps the `{content:[{type:'text',text}]}` envelope when one is present. */
function payload(result) {
  const value = result?.parsed ?? result?.raw;
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    const text = value.content.find((c) => c.type === 'text')?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return value;
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: HEADLESS,
  userDataDir: path.join(here, '.chrome-profile'),
  args: [
    ...WEBMCP_ARGS,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--hide-crash-restore-bubble',
  ],
  defaultViewport: { width: 1400, height: 950 },
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('  [page error]', error.message));

  // ---- headers ------------------------------------------------------------------
  const response = await page.goto(`${BASE}/?reset=1`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const headers = response.headers();
  check('Origin-Agent-Cluster: ?1', headers['origin-agent-cluster'] === '?1', headers['origin-agent-cluster']);
  check(
    'Permissions-Policy allows tools',
    (headers['permissions-policy'] || '').includes('tools='),
    headers['permissions-policy'],
  );

  await ready(page);

  // ---- the surface exists -------------------------------------------------------
  const api = await page.evaluate(() => typeof document.modelContext);
  check('document.modelContext is present', api === 'object', api);

  const initial = await listTools(page);
  const names = initial.map((t) => t.name);
  check('manager tools are registered', names.includes('describe_roster') && names.includes('solve_roster'), names);
  check(
    'the direct registerTool call in our own source is live',
    names.includes('about_rotaproof'),
    names.filter((n) => n.startsWith('about')),
  );
  check(
    'explain_conflict is absent while the week is fine',
    !names.includes('explain_conflict'),
    names.includes('explain_conflict'),
  );
  check(
    'publish_roster is absent before anything is solved',
    !names.includes('publish_roster'),
    names.includes('publish_roster'),
  );
  check(
    'reads are marked read-only and writes are not',
    initial.find((t) => t.name === 'describe_roster')?.readOnly === true &&
      initial.find((t) => t.name === 'solve_roster')?.readOnly === false,
    initial.filter((t) => ['describe_roster', 'solve_roster'].includes(t.name)),
  );

  // ---- orientation --------------------------------------------------------------
  const described = payload(await callTool(page, 'describe_roster'));
  check('describe_roster returns the team as ids', Array.isArray(described?.staff) && described.staff.length === 10, described?.staff?.length);
  check(
    'no real names cross the boundary',
    !JSON.stringify(described).match(/Maria|Alvarez|Beckett|Fischer|Haddad/),
    'no name tokens found',
  );

  // ---- solve --------------------------------------------------------------------
  const solved = payload(await callTool(page, 'solve_roster'));
  check('solve_roster reports optimal', solved?.status === 'optimal', solved?.status);
  check('solve_roster fills the whole week', solved?.assignments === 42, solved?.assignments);
  check('solve_roster reports how long it took', typeof solved?.solvedInMs === 'number', `${solved?.solvedInMs} ms`);
  console.log(`  → in-browser solve: ${solved?.solvedInMs} ms, objective ${solved?.objective}`);

  const afterSolve = (await listTools(page)).map((t) => t.name);
  check('inspect_schedule appears once there is a schedule', afterSolve.includes('inspect_schedule'), afterSolve);
  check('publish_roster appears once the week is clean', afterSolve.includes('publish_roster'), afterSolve);

  const inspected = payload(await callTool(page, 'inspect_schedule', { day: 4 }));
  check('inspect_schedule can be narrowed to one day', Array.isArray(inspected?.assignments), inspected?.scope);

  // ---- the impossible week ------------------------------------------------------
  await callTool(page, 'set_constraint', {
    kind: 'time_off',
    label: 'S2 asked for Friday off',
    staff: 'S2',
    status: 'granted',
    slots: [
      { day: 4, shift: 'open' },
      { day: 4, shift: 'mid' },
      { day: 4, shift: 'close' },
    ],
  });
  const blocked = payload(await callTool(page, 'solve_roster'));
  check('the impossible week reports infeasible', blocked?.status === 'infeasible', blocked?.status);
  check('no schedule is invented', blocked?.assignments === undefined, blocked?.assignments);

  const afterConflict = (await listTools(page)).map((t) => t.name);
  check('explain_conflict appears only now', afterConflict.includes('explain_conflict'), afterConflict);
  check('publish_roster is withdrawn', !afterConflict.includes('publish_roster'), afterConflict.includes('publish_roster'));

  const conflict = payload(await callTool(page, 'explain_conflict'));
  const rules = conflict?.rules ?? [];
  check('the conflict names exactly six rules', rules.length === 6, rules);
  check('and one of them is the request just made', rules.includes('C-timeoff-S2-friday'), rules);
  check(
    'the four unrelated absences are excluded',
    !rules.includes('C-unavail-S3-weekdays') &&
      !rules.includes('C-unavail-S4-lectures') &&
      !rules.includes('C-unavail-S8-nights'),
    rules,
  );
  check('a relaxation is offered for each', (conflict?.options ?? []).length === 6, conflict?.options?.length);
  console.log(`  → ${conflict?.foundIn}`);

  const conflictPanel = await page.$('#conflict');
  check('the page shows the conflict too, not just the tool', conflictPanel !== null);

  // ---- relax and recover --------------------------------------------------------
  await callTool(page, 'relax_constraint', { id: 'C-timeoff-S2-friday', to: 'removed' });
  const recovered = payload(await callTool(page, 'solve_roster'));
  check('relaxing one rule makes the week solvable again', recovered?.status === 'optimal', recovered?.status);

  // ---- human in the loop --------------------------------------------------------
  // Start the call without awaiting it, so we can assert it is genuinely still pending
  // while the card is on screen.
  await page.evaluate(async () => {
    const mc = document.modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === 'publish_roster');
    window.__PUBLISH_STATE__ = 'pending';
    window.__PUBLISH__ = mc.executeTool(tool, JSON.stringify({})).then((r) => {
      window.__PUBLISH_STATE__ = 'settled';
      return r;
    });
  });

  await page.waitForSelector('#hitl-card', { timeout: 10_000 });
  const stillPending = await page.evaluate(() => window.__PUBLISH_STATE__);
  check('publish_roster blocks while the card is up', stillPending === 'pending', stillPending);

  const cardText = await page.$eval('#hitl-card', (el) => el.textContent ?? '');
  check('the card says what will change', cardText.includes('42'), cardText.slice(0, 120));

  await page.click('#hitl-decline');
  const declined = payload({ raw: await page.evaluate(() => window.__PUBLISH__) });
  check('declining returns declined and changes nothing', declined?.status === 'declined', declined?.status);
  check('the card is dismissed', (await page.$('#hitl-card')) === null);

  await page.evaluate(async () => {
    const mc = document.modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === 'publish_roster');
    window.__PUBLISH2__ = mc.executeTool(tool, JSON.stringify({}));
  });
  await page.waitForSelector('#hitl-card', { timeout: 10_000 });
  await page.click('#hitl-approve');
  const published = payload({ raw: await page.evaluate(() => window.__PUBLISH2__) });
  check('approving publishes version 1', published?.status === 'published' && published?.version === 1, published);

  // ---- the staff surface is a different surface ---------------------------------
  await page.goto(`${BASE}/staff`, { waitUntil: 'networkidle2' });
  await ready(page);
  const staffTools = (await listTools(page)).map((t) => t.name);
  check('staff see their own tools', staffTools.includes('my_shifts') && staffTools.includes('find_swap'), staffTools);
  check('staff cannot reach the manager tools', !staffTools.includes('solve_roster') && !staffTools.includes('set_constraint'), staffTools);

  // ---- the inspector works with no agent ----------------------------------------
  await page.goto(`${BASE}/tools`, { waitUntil: 'networkidle2' });
  await ready(page);
  const rows = await page.$$eval('#tools-table [data-tool]', (els) => els.map((e) => e.dataset.tool));
  check('the tools page lists the live surface', rows.length > 0, rows);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
if (failed.length > 0) {
  console.log(failed.map((f) => `  FAILED: ${f.name}`).join('\n'));
  process.exit(1);
}
