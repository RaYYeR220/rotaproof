# Working on RotaProof

Orientation for anyone — or anything — editing this repository.

## Shape

```
packages/core/       domain model, checker, MIP compiler, LP writer, HiGHS adapter,
                     deletion filter, receipts, redaction boundary
packages/registry/   the single action registry, argument validation, the WebMCP
                     binding, and a headless session for driving it without a DOM
apps/web/            Next.js 16, entirely client-side
evals/               eval suites in Chrome's expectedCall format
tests/               the Chrome harness that drives the real page
scripts/             receipt verification, eval runner
receipts/            committed golden receipts
```

## The three rules that matter

**1. A capability is declared once, in `packages/registry/src/actions/`.**
Both the human UI and the WebMCP tool surface are generated from it. If you add a button
that does something the registry does not know about, you have created a second code path
for humans, the agent surface has silently fallen behind, and `parity.test.ts` will fail.
That test is not bureaucracy — drift between the two surfaces is the standing objection to
this whole approach, and the registry is the answer to it.

To withhold something from agents deliberately, set `agentExempt` with a real sentence
saying why. Three things are withheld today; read them before adding a fourth.

**2. Private fields never cross the tool boundary.**
`Staff.name`, `Staff.notes`, `Staff.hourlyRate`, `UnavailableConstraint.reason` and
`TimeOffConstraint.note` are the roster's personal data. Everything an agent receives goes
through `packages/core/src/redact.ts`, which is an *allow-list* — `publicStaff` copies named
fields rather than deleting unwanted ones, so a new private field cannot leak by being
forgotten.

Error messages are the easiest place to slip. Never interpolate a name into one.
`privacy.test.ts` will catch you, including in hint text.

**3. The checker and the compiler must agree.**
`check.ts` and `compile.ts` implement the same rules twice on purpose: the solver's output
is validated by code that shares none of its machinery, and a disagreement downgrades the
result to `error` rather than returning a roster. If you add a constraint kind, add it to
both, and add a case to `check.test.ts` *and* `compile.test.ts`. They share their slot
arithmetic through the helpers in `model.ts` — put anything time-related there so it cannot
drift.

## Adding a constraint kind

1. `model.ts` — the interface, added to the `Constraint` union and to `CONSTRAINT_KINDS`.
2. `check.ts` — a `case` in `checkOne`, returning violations with agent-safe messages.
3. `compile.ts` — a `case` in `compileRoster`, with rows tagged `constraint.id`.
4. `validate.ts` — a `case` in `buildConstraint`, with a hint naming the fields it needs.
5. `solve.ts` — a `case` in `suggest`, saying what relaxing it would buy.
6. Tests in all three suites, plus an eval case in `evals/manager.json`.
7. A `group` — it decides how the conflict explanation reads.

## Facts about the platform that are easy to get wrong

These were measured against Chrome 151, not read from documentation.

- The object is **`document.modelContext`**. `navigator.modelContext` is a legacy alias.
- **`execute()` is called with exactly one argument.** The `AbortSignal` the spec describes
  as the second parameter is not passed. Never destructure it.
- **Never `throw` from `execute`.** The message is discarded and replaced with a generic
  `UnknownError`, and it also surfaces as an uncaught page error. Return a structured
  failure.
- **There is no `unregisterTool`.** An `AbortController` passed at registration is the only
  way to remove a tool.
- **Re-registering an existing name rejects**; it does not replace. Abort first.
- **Only two annotations exist:** `readOnlyHint` and `untrustedContentHint`. `destructiveHint`
  and `requestUserInteraction()` do not exist in any shipping build, whatever a blog post
  says.
- `getTools()` returns `inputSchema` as a **JSON string**; puppeteer's `page.webmcp` returns
  it as an object and renames the annotations. Handle both.
- `executeTool(handle, JSON.stringify(args), { signal })` is the only accepted call shape.
- **`Origin-Agent-Cluster: ?0` disables WebMCP entirely.** Do not add it.
- Tool names must match `/^[a-zA-Z0-9_.-]{1,128}$/`; Chrome recommends 30 characters.

## Commands

```bash
pnpm install
pnpm dev                # http://localhost:3000
pnpm check              # types, tests, receipts — run this before you push
pnpm test:webmcp        # real Chrome, real tool surface
pnpm evals              # deterministic eval smoke, no model or API key
pnpm verify:receipt     # re-solve and compare against receipts/seed.json
```

If a change legitimately alters what the solver returns for the seeded week,
`pnpm verify:receipt` will fail. Regenerate with
`node scripts/verify-receipt.mjs --write` and commit the new receipts *as part of that
change*, so the diff shows what moved.

## Things not to do

- Do not add a server. There isn't one, and its absence is a product claim: the roster never
  leaves the browser. No route handlers, no server actions, no outbound `fetch`.
- Do not set `presolve: 'off'` on HiGHS. It turns a 40 ms solve into a 30 s timeout.
- Do not read binary variables as `=== 1`. Use `> 0.5`.
- Do not call anything here "elicitation". That API does not exist; what this page does is
  return a promise it resolves on a real click.
