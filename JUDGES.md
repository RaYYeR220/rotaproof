# Reviewing RotaProof in five minutes

No account, no credentials, no install, no faucet. The roster is seeded and the page works
the moment it loads.

---

## 1. Sixty seconds, no agent at all

Open **<https://rotaproof.vercel.app/tools>**.

That page lists the live WebMCP surface — every registered tool, its description, its
schema, and whether it is a read or a write — read back from `document.modelContext` itself.
There is also a console that runs any tool by hand.

It is there because you may not want to wire up an agent to check whether the tools are
real. You can see the whole surface, and execute it, without one.

Then open **<https://rotaproof.vercel.app>** and press **Solve**. A ten-person week is
built to proven optimality in roughly a third of a second, in your browser. Nothing is sent
anywhere; you can turn off the network afterwards and everything still works.

## 2. The two minutes that matter

Still on the main page, click **"Grant S2 the Friday off"** (or ask an agent to — see below).

The page does not produce a roster, because there isn't one. It answers:

> These rules cannot all hold at once: **A keyholder must open**, **A keyholder must close**,
> **11 hours rest between shifts**, **S6 cannot work Fridays**, **S9 is away Thursday and
> Friday**, **S2 asked for Friday off**. Every one of them is needed for the clash — drop any
> single one and the rest fit.

Two things to check, because they are the claim:

- **Six rules, not fifteen.** Four other people are also away that week for unrelated
  reasons. They are not listed, and proving they are irrelevant is most of the work.
- **It stops there.** It offers what relaxing each rule would buy and does not choose. Which
  rule gives way is a judgement about people.

Now click one of the relaxations. The week solves.

## 3. Watching the tool surface change

Note the browser's **Site tools** count as you go. It is not constant:

| state | tools an agent can see |
|---|---|
| manager, nothing solved | `describe_roster` `list_constraints` `set_constraint` `relax_constraint` `solve_roster` |
| manager, solved cleanly | the above **+ `inspect_schedule` + `publish_roster`** |
| manager, infeasible | the above **+ `explain_conflict`**, and **no** `publish_roster` |
| staff | a different surface entirely — `my_shifts`, `request_time_off`, `find_swap`, … |

Tools are registered when they become possible and aborted when they stop being. The tool
list *is* the state of the page.

## 4. Driving it with an agent

**ChatGPT desktop app** — open the URL in its built-in browser. WebMCP is on by default.
Try, in order:

1. *"What is this page and who is on the team?"*
2. *"Build this week's roster."*
3. *"S2 has asked for Friday off. Grant it and rebuild. If it can't be done, tell me exactly what is stopping it."*
4. *"Drop the request again and publish the roster."* — the agent's call will hang until you
   click Approve in the page. Click Decline instead and watch it come back `declined` with
   nothing changed.

**Chrome 149+** — launch with
`--enable-features=WebMCP --enable-blink-features=WebMCP`, or enable
`chrome://flags/#enable-webmcp-testing`.

## 5. Checking the claims

```bash
git clone <repo> && cd rotaproof && pnpm install

pnpm test           # 190 tests
pnpm test:webmcp    # drives real Chrome and asserts the live tool surface
pnpm evals          # 40 eval cases, deterministic, no model and no API key
pnpm verify:receipt # re-solve a published receipt and compare hashes
```

Four of those are worth looking at specifically.

**`packages/registry/test/parity.test.ts`** fails the build on any capability that exists for
humans but not for agents without a written reason. Three are withheld; each says why in the
source. This is the answer to the standing objection that a WebMCP site ends up maintaining
two versions of itself until the agent is calling a tool that lies.

**`packages/registry/test/privacy.test.ts`** replaces every private field — names, absence
reasons, pay — with a unique random token, then calls every tool many times with sensible
*and* hostile arguments, across both roles and both feasible and infeasible states, and
fails if one token appears in one result. Its **negative control** plants a leak on purpose
and requires the same check to catch it, so a pass cannot be vacuous.

**`packages/core/test/solve.test.ts`** does not take the conflict explanation on trust. It
checks minimality by construction: strip the model to the reported conflict and it must
still be impossible; then remove each member in turn and each time the rest must become
solvable. It also carries a negative control — a model that *must* fail — so a green suite
cannot mean the infeasible path was never exercised.

**`packages/core/src/solve.ts`** is the deletion filter itself, in two passes, with the
reason the second pass exists written above it.

## 6. Where to look in the code

| | |
|---|---|
| The literal `document.modelContext.registerTool` call | `apps/web/components/ModelContextBridge.tsx` |
| Tool lifecycle, dynamic registration, HITL plumbing | `packages/registry/src/webmcp.ts` |
| The single registry both surfaces read | `packages/registry/src/actions/` |
| Roster rules → mixed-integer program | `packages/core/src/compile.ts` |
| Minimal-conflict deletion filter | `packages/core/src/solve.ts` |
| The redaction boundary | `packages/core/src/redact.ts` |

## 7. What does not work

Listed plainly in [README.md](README.md#honest-limits), and worth knowing before you test:

- Chrome 151 calls `execute()` with one argument, so the `AbortSignal` the spec describes is
  not there. The binding supplies its own.
- When an agent abandons a call, the page is never notified — so every confirmation card
  carries its own Cancel. That is a browser gap, not a design choice.
- Shadow prices come from the LP relaxation, not the integer problem, and say so wherever
  they appear.
- The three tools that wait for a human click are absent from the eval suites, because an
  eval run has no human. Adding a bypass so they could be scored would defeat the mechanism
  they exist to demonstrate. The Chrome harness covers them, and it does click.
