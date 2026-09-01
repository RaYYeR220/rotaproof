# Claims and evidence

Every factual claim this project makes in its README, its demo video or its submission,
with the evidence behind it and how to re-derive it yourself.

Tiers:

| tier | meaning |
|---|---|
| **REPRODUCIBLE** | A command in this repo produces the number. Run it. |
| **MEASURED** | Observed on a named build and machine; your numbers will differ a little. |
| **DESIGNED** | A property of the code you can read, not a measurement. |
| **NOT CLAIMED** | Something a reader might reasonably assume, that we are *not* asserting. |

Measurements below were taken on Windows 11, Node 24.13.0, Chrome 151.0.7922.174,
`highs@1.15.2`.

---

## The solver

| claim | tier | evidence |
|---|---|---|
| The seeded ten-person week solves to **proven optimality**, objective **28.42**, **42** assignments | REPRODUCIBLE | `pnpm test packages/core/test/solve.test.ts` |
| Solve time **~270 ms** for 210 binaries / ~320 rows | MEASURED | test output; browser figures on `/tools` |
| The same rules always produce the same schedule hash | REPRODUCIBLE | `solve.test.ts` → "is deterministic — the same rules give the same receipt" |
| The solver's schedule is re-checked by an independent checker before it is returned; a disagreement downgrades the result to `error` | DESIGNED | `packages/core/src/solve.ts`, `check.ts` |
| A schedule the checker rejects is never presented as valid | REPRODUCIBLE | `solve.test.ts` → "produces a schedule the independent checker accepts" |
| **The solver runs entirely in the browser. No roster data is transmitted.** | DESIGNED | There is no server. No route handlers, no server actions, no `fetch` to any origin. Load the page, disconnect, keep working. |

## The conflict explanation

| claim | tier | evidence |
|---|---|---|
| Granting one Friday off makes the seeded week impossible, and the page says so instead of producing a roster | REPRODUCIBLE | `solve.test.ts` → "reports infeasible rather than inventing a schedule" |
| It names **exactly six** rules | REPRODUCIBLE | `solve.test.ts` → "names the rules that actually clash and leaves the unrelated absences out" |
| The six are **irreducible** — strip the model to them and it is still impossible; remove any one and it becomes solvable | REPRODUCIBLE | `solve.test.ts` → "returns a genuinely minimal set" (both halves are asserted) |
| The four unrelated absences that week are **excluded** | REPRODUCIBLE | same test, explicit `not.toContain` assertions |
| Found in **25 solver probes, ~320 ms** | MEASURED | printed by the test run |
| Explanation completes in under 5 s | REPRODUCIBLE | `solve.test.ts` → "explains itself quickly enough to be interactive" |
| Each option says whether relaxing it **alone** fixes the real roster, and on the seeded conflict **five of the six do** | REPRODUCIBLE | `softening.test.ts` → "says which single relaxations are actually enough" and "every claim it makes about sufficiency is true of the real model" |
| An unfinished probe is counted and the narrative stops claiming minimality | DESIGNED | `solve.ts`, `ConflictExplanation.inconclusive`; `softening.test.ts` asserts it is zero when every probe finishes |
| **NOT CLAIMED:** that the reported set is the *only* minimal one | NOT CLAIMED | A model can have several irreducible conflicting subsets. This returns one of them, found by deletion filtering in a fixed order, which is why the same rules always give the same answer. |
| **NOT CLAIMED:** that this is HiGHS's own IIS | NOT CLAIMED | It is not. The wasm build exports fourteen C-API functions and `Highs_getIis` is not among them; setting `iis_strategy` is accepted and does nothing. This is deletion filtering, written here. |
| **NOT CLAIMED:** that the filter is efficient at arbitrary scale | NOT CLAIMED | The second pass is linear in the rules of the surviving groups. At tens of rules that is a couple of dozen probes. Hundreds of rules would want a chunked variant, which is not implemented. |

## Privacy

| claim | tier | evidence |
|---|---|---|
| No name, private note, absence reason or pay rate reaches any tool result | REPRODUCIBLE | `packages/registry/test/privacy.test.ts` — every private field becomes a unique token, every tool is called many times with sensible and hostile arguments across both roles and both feasible and infeasible states, one hit fails the build |
| That test can actually fail | REPRODUCIBLE | Its **negative control** plants a leak deliberately and requires the same check to catch it |
| Redaction is an allow-list, so a new private field cannot leak by being forgotten | DESIGNED | `packages/core/src/redact.ts` — `publicStaff` copies named fields rather than deleting them |
| Tool output is capped at 1,450 characters and says when it was trimmed | DESIGNED | `redact.ts`, `boundResult` / `boundList` |
| **NOT CLAIMED:** that an agent cannot infer anything about individuals | NOT CLAIMED | It sees per-person shift counts, skills, contract bounds and which slots are blocked. That is the working data of a roster. It never sees who anyone *is*. |

## The WebMCP surface

| claim | tier | evidence |
|---|---|---|
| The human UI and the tool surface are generated from one registry | DESIGNED | `packages/registry/src/actions/`; every UI control dispatches a registry action |
| A capability that exists for humans but not agents fails the build unless a reason is written | REPRODUCIBLE | `packages/registry/test/parity.test.ts` |
| Exactly three capabilities are withheld, each with a stated reason | REPRODUCIBLE | same test asserts the list by name |
| Tools register and unregister with page state; `explain_conflict` exists only while infeasible, `publish_roster` only when there is a clean solved week | REPRODUCIBLE | `packages/registry/test/actions.test.ts` → "the tool surface follows the state" |
| `readOnlyHint` is set on reads and never on writes; the read/write split is asserted by name | REPRODUCIBLE | `parity.test.ts` |
| Tool names, description budgets and parameter-description budgets conform to Chrome's guidance, with two named exceptions | REPRODUCIBLE | `parity.test.ts`; the exceptions are `set_constraint` and `solve_roster` and the reason is in the test |
| Failures return a named error plus a hint naming valid values | REPRODUCIBLE | `actions.test.ts` → "argument validation guides rather than blocks" |
| `publish_roster` blocks until a person clicks, and returns `declined` if they refuse | REPRODUCIBLE | `actions.test.ts` → "publishing waits for a person" |
| Publishing re-checks the model after the click, so a rule change during the confirmation cannot slip through | DESIGNED | `manager.ts`, `roster_changed` |
| A read-only tool leaves the session exactly as it found it | REPRODUCIBLE | `swaps.test.ts` → "asking a hypothetical changes nothing" |
| A swap is verified against the **named person**, not merely against the slot being staffed | REPRODUCIBLE | `swaps.test.ts` → "every candidate it offers really can take the shift" |
| A time-off request is recorded softly, so an unapproved request cannot make the manager's week impossible | REPRODUCIBLE | `swaps.test.ts` → "an unapproved request cannot break the manager week" |
| Softening a rule genuinely softens it, for every rule kind | REPRODUCIBLE | `softening.test.ts` → "a soft rule is genuinely soft", parameterised over eight rules |
| The objective the solver minimises and the soft cost the checker reports are the **same quantity** | REPRODUCIBLE | `softening.test.ts` → "objective and reported soft cost are the same quantity", including with a ledger |

## Browser behaviour

| claim | tier | evidence |
|---|---|---|
| The live page registers its tools and they are callable in Chrome 151 with WebMCP enabled | REPRODUCIBLE | `pnpm test:webmcp` — drives real Chrome, asserts headers, `getTools()`, execution, dynamic registration, and a real click through the confirmation card |
| `Origin-Agent-Cluster: ?1` and `Permissions-Policy: tools=(self)` are served | REPRODUCIBLE | asserted by the same harness against the deployed URL |
| Chrome 151 calls `execute()` with one argument, so the spec's `AbortSignal` is absent | MEASURED | probed directly; the binding supplies its own controller and reads `options?.signal` so it starts working when the browser ships it |
| When an agent abandons a call the page is not notified | MEASURED | agent side rejects with `AbortError`, page keeps waiting — hence the Cancel on every card |
| **NOT CLAIMED:** that this works in every browser | NOT CLAIMED | Two runtimes consume WebMCP today: the ChatGPT desktop app's built-in browser, and Chromium with the flag. Elsewhere the page is an ordinary, fully working web app with no tool surface, and `/tools` says so. |

## The evals

| claim | tier | evidence |
|---|---|---|
| 40 eval cases in Chrome's `expectedCall` format, covering both roles | REPRODUCIBLE | `evals/manager.json` (30), `evals/staff.json` (10) |
| They run with **no model and no API key** | REPRODUCIBLE | `pnpm evals` → `webmcp-evals smoke` |
| **NOT CLAIMED:** a tool-selection accuracy figure | NOT CLAIMED | `smoke` proves the tools exist and accept those arguments; it does not involve a model and therefore says nothing about whether a model would pick them. Measuring that needs `webmcp-evals browser` with a real model, which is not run in CI here. We are not quoting a percentage we have not measured. |
| **NOT CLAIMED:** eval coverage of the three human-gated tools | NOT CLAIMED | `publish_roster`, `offer_swap` and `accept_swap` wait for a click. They are absent from the suites and covered by the Chrome harness instead. |

## Across weeks

| claim | tier | evidence |
|---|---|---|
| Publishing and starting the next week folds what everybody worked into the fairness history | REPRODUCIBLE | `next-week.test.ts` → "moves the week on and folds the published roster into the history" |
| The carried history changes what the solver does | REPRODUCIBLE | `ledger.test.ts` → "pushes weekend work away from whoever has been carrying it" |
| Rules pinned to particular days are cleared on roll-forward and listed for a human to re-add | REPRODUCIBLE | `next-week.test.ts` → "clears the rules that were pinned to last week and says which" |
| **NOT CLAIMED:** that recurring absences are detected | NOT CLAIMED | "Never works Fridays" and "away this Thursday" are indistinguishable in the data. Rather than guess, both are cleared and both are reported. |

## Receipts

| claim | tier | evidence |
|---|---|---|
| Every solve returns a SHA-256 of the canonical model, the solver version, the status, and a hash of the schedule or the conflict | DESIGNED | `packages/core/src/solve.ts` |
| A published roster can be re-derived and compared | REPRODUCIBLE | `pnpm verify:receipt` |
| Key order and assignment order do not affect the hash | DESIGNED | `canonicalize` sorts keys; the schedule is sorted before hashing |

## Things we are deliberately not saying

- **Not** that this replaces a rostering product. It plans one horizon at a time. Payroll,
  timeclocks, awards interpretation and multi-site are all out of scope.
- **Not** that the objective encodes real labour cost. It prices soft rules plus a flat
  0.01 per assignment so nobody is rostered for no reason. Pay rates are held for local
  display and never enter the objective, so the objective cannot leak them.
- **Not** that shadow prices are exact. They are LP-relaxation duals, labelled as such.
- **Not** that the agent is what makes this correct. The agent is a good interface. The
  solver is what makes the answers true, and the checker is what makes the solver
  accountable.
