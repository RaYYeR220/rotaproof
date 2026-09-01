# What CI covers, and what it does not

`ci.yml` runs on every push: types, the 128 unit and integration tests, the receipt
reproduction check, and a production build.

It does **not** run the two browser suites — `pnpm test:webmcp` and `pnpm evals` — because
both need Chrome launched with WebMCP enabled, which is a runtime flag on a specific
channel rather than something a hosted runner offers. Pretending otherwise with a skipped
job would make the badge mean less than it does.

Those two are run locally against the deployed URL, and the commands are in
[JUDGES.md](../../JUDGES.md).
