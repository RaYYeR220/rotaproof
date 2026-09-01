# RotaProof

**A shift roster that an agent can plan and a solver can prove — in your browser, over data the agent is never allowed to see.**

Live: <https://rotaproof.vercel.app> · Tool surface: <https://rotaproof.vercel.app/tools> · Reviewer's path: [JUDGES.md](JUDGES.md)

---

## The problem

Rostering is a constraint problem that looks like a conversation. A manager says *"give Tom
Friday off"* and means *"re-solve a 210-variable integer program under thirty-three rules, and
tell me if it can't be done."*

Language models are very good at the conversation and very bad at the program. Ask one to
build a ten-person week with coverage minimums, keyholder cover, eleven-hour rest, contract
ceilings and floors, and five separate absences, and it will produce something that looks
like a roster. It will not be optimal, it will usually break a rule, and — worst of all —
when the week is genuinely impossible it will hand you a schedule anyway, because producing
plausible text is what it does.

That failure is expensive in a way that is easy to miss. Nobody notices a wrong roster in
the tool. They notice it on a Friday night when the café cannot legally open.

## What this is

A web page that gives the agent the thing it does not have: **a real mixed-integer solver,
compiled to WebAssembly, running in the tab.**

The agent talks to the manager and edits the rules. The solver decides. Every answer is one
of exactly three:

- **`optimal`** — a roster exists, and no better one exists under these rules.
- **`infeasible`** — no roster exists. Not "I couldn't find one": *none exists*, and here is
  the minimal set of rules that cannot hold together.
- **`timeout`** — the budget ran out. Whatever came back is valid but may not be best.

There is no fourth branch where it guesses.

In the browser, on the seeded ten-person week: **331 ms** cold, **198 ms** warm, and **206 ms**
to prove a week impossible and name the six rules responsible.

### The moment the product is about

Grant one person a Friday off in the seeded week and the page answers:

> These rules cannot all hold at once: **A keyholder must open**, **A keyholder must close**,
> **11 hours rest between shifts**, **S6 cannot work Fridays**, **S9 is away Thursday and
> Friday**, and **S2 asked for Friday off**. Every one of them is needed for the clash — drop
> any single one and the rest fit.
>
> *Found in 25 solver probes, 320 ms.*

Four other people are also away that week. The page does not mention them, because they are
not part of the conflict — and proving *that* is most of the work.

It also says which of the six would be enough **on its own**. Five of them would; relaxing
the rest rule alone would not, because a second rule independently forbids the same double
shift. Minimality inside a set is a weaker statement than it sounds, and sending a manager
off to relax a rule that will not help is the worst thing this product could do.

Then it stops. Choosing which rule gives way is a judgement about people, and neither the
agent nor the solver is entitled to make it.

## Why WebMCP specifically

Three properties of this problem are not incidental — they are the argument for putting the
tools in the page rather than behind an API.

**The engine has to be where the data is.** Rosters contain names, pay rates, and the reasons
people are absent. That is the least uploadable data a small business owns. WebMCP lets the
computation happen inside the tab the manager already trusts, so the agent can operate on
the roster without the roster ever leaving the device. There is no server in this project at
all — no account, no upload, no database. Turn off the network after first load and
everything still works.

**The answer has to be a fact, not a message.** An in-page tool returns a value the model did
not author. `infeasible` plus six rule ids is not something an agent can talk its way around.

**Both parties need to be looking at the same thing.** The manager sees the grid fill in as
the agent solves; the agent sees the rules the manager just dragged. Neither is driving a
screenshot of the other.

## What people and agents can do together that they could not before

| | Before | Now |
|---|---|---|
| Manager | Describes a change, then hand-checks a roster the model invented | Describes a change and gets a proven-optimal week, or a proof that there isn't one |
| Manager | "It says it can't — I don't know why" | Six named rules, each with what relaxing it would buy |
| Staff | "Can I have Thursday off?" → *ask the manager, wait* | Immediate verdict with the blocking rules named |
| Staff | "Will anyone take my Friday?" → *ask in the group chat* | The list of colleagues the solver has **verified** can take it without breaking the week |
| Anyone | Upload the roster to use AI on it | The agent works on it; the file never leaves the browser |

## How WebMCP is used

### One registry, two surfaces

Every capability is declared exactly once, in `packages/registry`. The React UI renders its
controls from it, and the WebMCP layer registers its tools from it.

```
                 packages/registry/src/actions/
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
   React controls                      document.modelContext.registerTool
   (what a person clicks)              (what an agent calls)
```

There is no second code path for agents, so the two cannot drift apart — the standing
objection to WebMCP, that a site ends up maintaining two versions of itself until the agent
is calling a tool that lies. `packages/registry/test/parity.test.ts` fails the build on any
capability that is neither exposed to agents nor carries a written reason for being withheld.
Three are withheld, and each says why in the source.

### The tool surface is a function of state, not a constant

Tools are registered when they become possible and aborted when they stop being:

- `explain_conflict` **only exists while the roster is actually infeasible.**
- `publish_roster` **only exists once there is a clean solved week to publish.**
- The manager and staff views expose different surfaces entirely.

So the "Site tools — *N* read, *M* write" chip in the browser changes as you work. That is
the app's state, rendered as a tool list. `AbortController` is the only unregistration
mechanism the spec provides, which is exactly the right shape for this.

### Human-in-the-loop, built rather than borrowed

WebMCP has no confirmation API. The spec lists user prompting as an open question, and
`requestUserInteraction()` — which several third-party write-ups describe — does not exist in
the shipped spec or in any browser.

So `publish_roster` returns a promise the page resolves on a real click. The agent's tool
call stays open. The card shows exactly what will change. Declining returns
`{ status: 'declined' }` and nothing happens.

### Tool design decisions, and why

- **Six to nine tools per session, not thirty.** Register too many overlapping tools and a model
  picks badly; register 296 and the browser switches WebMCP off for the whole document.
- **Registration order is chosen.** Models show positional bias toward tools listed earlier,
  so orientation comes first, then reads, then the engine, then writes.
- **Description length is per-tool, deliberately.** Chrome recommends 500 characters; the
  reference WebMCP app written by the spec's own author ships 2,500-character descriptions.
  Both are right for different surfaces. Here the leaf tools stay terse and the two tools
  that carry real semantics — `set_constraint` and `solve_roster` — get manual-grade
  descriptions, because for those the description *is* the documentation. The parity test
  pins that exception to exactly those two names.
- **`readOnlyHint` is written on every tool, including the writes.** The spec says its
  absence is the write signal, and that is true of the spec but not of the shipping
  consumer: ChatGPT's built-in browser reads the property to build its read/write split, so
  omitting it on writes displays a six-tool surface as "3 read, 0 write tools" — the writes
  disappear from the exact affordance a person uses to decide whether to trust the page.
  Found by opening this app in the ChatGPT desktop app and looking at the chip.
- **`untrustedContentHint` on the one tool that returns text a colleague wrote.**
- **Errors are guides.** A bad staff id comes back as *"There is no staff member 'Maria'.
  Valid staff ids: S1, S2, S3…"*, so an agent can correct itself without a human.
- **Outputs are bounded to 1,450 characters** and say when they were trimmed, with the call
  that would narrow them.

### The redaction boundary

Every tool result passes through `packages/core/src/redact.ts`. Agents see `S3`, roles,
skills, counts and structure. They never see names, private notes, absence reasons or pay.

This is tested as a property, not asserted as a policy: `privacy.test.ts` replaces every
private field with a unique random token, calls every tool many times with sensible *and*
hostile arguments across both roles and both feasible and infeasible states, and fails the
build if one token appears in one result. Its negative control plants a leak on purpose and
requires the same check to catch it, so a pass cannot be vacuous.

## Architecture

```
  ┌─────────────────────────── the browser tab ────────────────────────────┐
  │                                                                        │
  │   React UI  ◄──────┐                          ┌──────► document.       │
  │   (people)         │                          │        modelContext    │
  │                    │                          │        (agents)        │
  │              ┌─────┴──────────────────────────┴─────┐                  │
  │              │      @rotaproof/registry             │                  │
  │              │  one action per capability, with      │                 │
  │              │  schema · role · state predicate      │                 │
  │              └─────────────────┬─────────────────────┘                 │
  │                                │                                       │
  │              ┌─────────────────▼─────────────────────┐                 │
  │              │        @rotaproof/core                │                 │
  │              │  model · checker · MIP compiler ·     │                 │
  │              │  deletion filter · receipts · redact  │                 │
  │              └─────────────────┬─────────────────────┘                 │
  │                                │                                       │
  │                      ┌─────────▼──────────┐                            │
  │                      │  HiGHS (WebAssembly)│  in a Web Worker          │
  │                      └────────────────────┘                            │
  │                                                                        │
  │   IndexedDB ── the roster, never transmitted                           │
  └────────────────────────────────────────────────────────────────────────┘

                     no server · no account · no upload
```

**`@rotaproof/core`** — the domain model, a deterministic checker that shares its slot
arithmetic with the compiler so the two cannot disagree, a compiler from roster rules to a
mixed-integer program, a CPLEX LP writer, the HiGHS adapter, the two-pass deletion filter,
and the redaction boundary.

**`@rotaproof/registry`** — the single action registry, argument validation that returns
guides rather than rejections, the WebMCP binding, and a headless session so the whole
engine can be driven from Node with no DOM.

**`apps/web`** — Next.js 16, entirely client-side.

### How infeasibility is explained

Deletion filtering, twice. Start from the hard rules, which are known to be unsatisfiable.
Remove one candidate and ask whether the model is *still* impossible: if it is, that
candidate was not to blame and stays out for good; if the model becomes solvable, the
candidate is load-bearing and goes back. What survives is irreducible.

The first pass runs over named groups — coverage, keyholder cover, working time, contracts,
availability — which is cheap because there are few groups. The second pass then filters the
individual rules inside the groups that survived.

The second pass is what makes the answer readable. Without it, granting one Friday off
implicates *"availability"*, and therefore every absence that week, including four with
nothing to do with the clash. With it, six rules and no others.

### Receipts

Every solve returns a receipt: a SHA-256 of the canonical model, the solver version, the
status, the objective, and a hash of the schedule or of the conflict. The same rules produce
the same hashes, so a published roster can be re-derived and checked later rather than taken
on trust. `pnpm verify:receipt` does exactly that.

## Running it

```bash
pnpm install
pnpm dev            # http://localhost:3210
```

Then open it in a browser that speaks WebMCP:

- **ChatGPT desktop app** — its built-in browser supports WebMCP natively. Nothing to enable.
- **Chrome 149+** — `chrome://flags/#enable-webmcp-testing`, or launch with
  `--enable-features=WebMCPTesting --enable-blink-features=WebMCP`.

Without either, the page works completely as an ordinary web app; the tool surface is simply
absent and `/tools` says so.

```bash
pnpm test              # 190 tests: model, solver, parity, privacy, behaviour
pnpm test:webmcp       # drives real Chrome and asserts the live tool surface
pnpm evals             # deterministic eval smoke run, no model and no API key
pnpm verify:receipt    # re-solve a published receipt and compare hashes
```

## Honest limits

- **Chrome 151 calls `execute()` with one argument.** The `AbortSignal` the spec describes as
  the second parameter is not there yet, so the binding supplies its own per-call controller.
- **When an agent abandons a call, the page is never told.** The agent side rejects with an
  `AbortError`; the page keeps waiting. A confirmation card would sit there forever, so every
  card carries its own Cancel. This is a browser gap, not a design choice.
- **Chrome 151 aborts a running `execute` if that tool's registration is aborted.** This is a
  nasty interaction with a state-driven tool surface: `solve_roster` sets `solving`, which
  makes `solve_roster` unavailable, so the sync unregistered the tool 15 ms into its own call
  and every agent-initiated solve died with `UnknownError`. The binding now holds any sync
  requested while a call is in flight and runs it when the call ends. Worth knowing before
  you build anything that changes its own availability.
- **Shadow prices come from the LP relaxation**, not the integer problem. They are a good
  guide to which rule is expensive and are not the exact integer cost. Labelled as such
  everywhere they appear.
- **`publish_roster`, `offer_swap` and `accept_swap` are absent from the eval suites**,
  because they wait for a human click and an eval run has no human. Adding a bypass so they
  could be scored would defeat the mechanism they exist to demonstrate. The Chrome harness
  covers them instead, and it does click.
- **HiGHS's native IIS is not reachable** from this WebAssembly build — the symbol is in the
  binary but the emscripten build exports fourteen C-API functions and `Highs_getIis` is not
  among them, and setting `iis_strategy` is accepted while doing nothing. Hence deletion
  filtering, which is slower in theory and 158 ms in practice at this size.
- **The deletion filter is linear in the number of rules** in the surviving groups. At the
  scale this app targets — tens of rules — that is 19 probes. A roster with hundreds of rules
  would want the chunked variant.
- **One week at a time.** Publishing and rolling forward carries everybody's totals into the
  next week's fairness objective, but the planner still solves a single horizon.
- **Recurring absences are not detected.** "Never works Fridays" and "away this Thursday"
  look identical in the data, so rolling forward clears both and lists them rather than
  guessing which should persist.
- **The conflict set is *a* minimal one, not the only one.** A model can have several
  irreducible conflicting subsets; deletion filtering in a fixed order returns one of them,
  which is also why the answer is stable.
- **`Origin-Trial` tokens are origin-bound**, so a local build never gets the native path from
  a token — the Chrome switch is the only local route.

## Licence

MIT. See [LICENSE](LICENSE).
