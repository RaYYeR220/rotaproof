# Evals

Two suites in the format Chrome documents for WebMCP, one per role.

| file | page | cases |
|---|---|---|
| `manager.json` | `/` | 30 |
| `staff.json` | `/staff` | 10 |

## What they are for

A tool surface is not correct because it exists. It is correct when a model reading only
the names, descriptions and schemas reaches for the right tool with the right arguments —
including the cases where the right answer is to read something rather than change it.

Each case is a plain-language request plus the calls it should produce. `expectedCall`
supports ordering (`ordered`, `unordered`) and matchers (`$type`, `$pattern`, `$lte`,
`$gte`), so a case can pin the parts that matter and leave a label or a timeout free.

## Running them

Deterministic, no model, no API key — this is the one that belongs in CI:

```bash
pnpm dev            # or: pnpm start, after pnpm build
npx webmcp-evals smoke -u "http://localhost:3210/?reset=1" -e evals/manager.json -v --chrome-channel chrome
npx webmcp-evals smoke -u "http://localhost:3210/staff?reset=1" -e evals/staff.json -v --chrome-channel chrome
```

`?reset=1` matters. The roster is kept in IndexedDB so a manager can close the tab and come
back, but the runner opens a fresh *page* per case against the same *profile*, so without a
reset the third case would inherit whatever the second one did.

`smoke` executes the expected calls straight against the live page, so it proves the
tools exist, accept those arguments and return without error. It does not involve a model
and cannot tell you whether a model would have picked them.

With a real model, which is what actually measures tool selection:

```bash
npx webmcp-evals browser -u http://localhost:3210/ -e evals/manager.json --chrome-channel chrome
```

Chrome needs WebMCP switched on either way:

```
--enable-features=WebMCPTesting --enable-blink-features=WebMCP
```

## Three honest notes

**`publish_roster`, `offer_swap` and `accept_swap` are absent from these suites.** They
block until a person clicks a confirmation in the page, and there is nobody to click
during an eval run. Adding a bypass so they could be scored would defeat the mechanism
they exist to demonstrate. They are covered instead by `tests/webmcp.harness.mjs`, which
drives real Chrome and does click.

**Two staff cases are coupled to the seeded optimum.** `find_swap` can only be asked about a
shift the signed-in person actually holds, so those cases name days that the seeded week's
optimal roster gives to S6. If the seed or the objective changes, the optimum can move and
those two cases have to move with it. The alternative — asking about a shift the person
might not have — would test the error path rather than the feature.

**Every case starts from the seeded week.** Each eval case gets a fresh page, so a
trajectory that needs the roster in a particular state has to put it there itself — which
is why several cases begin by adding a rule before solving.

A third thing worth knowing if you read the raw output: the runner scores a step as failed
when the result carries `isError: true`, `success: false`, or a string-valued `error` key.
Our failures are shaped `{ error, message, hint }` on purpose, because a model recovers far
better from a named error plus a hint than from a bare message. The consequence is that a
case which *should* fail cannot be expressed in this runner, so the suites contain none —
the recovery paths are covered by unit tests instead, in
`packages/registry/test/actions.test.ts` under "argument validation guides rather than
blocks".
