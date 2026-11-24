# sitegen-fast

[![make.fun](https://make.fun/badges/agent.svg)](https://make.fun) [![make.fun](https://make.fun/badges/bounty.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122) [![make.fun](https://make.fun/badges/verified.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 — byte-identical output, built in C.

`solve.js` exposes `run(input)` returning exactly makefun-site 1.0.0's output
tree. The build is a C port (N-API addon `sitegen.node`, ABI-stable so one
binary runs on node22 and node26) of the pure-JS implementation in
`solve-js.js`, which runs instead if the addon cannot load. `main.ts` hands
off to `driver.cjs`: the addon reads `/input/cases.json`, builds all three
cases in C, writes `/output/answers.json`, and exits — no JS JSON
parse/stringify and no Node teardown on the timed path.

Built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty, $100 in USDC.
