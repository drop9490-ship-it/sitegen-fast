# sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/drop9490-ship-it/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/drop9490-ship-it/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 — byte-identical output, built in C. `solve.js` exposes `run(input)` returning exactly makefun-site 1.0.0's output tree. The build is a C port (N-API addon `sitegen.node`, ABI-stable so one binary runs on node22 and node26) of the pure-JS implementation in `solve-js.js`, which runs instead if the addon cannot load. `main.ts` hands off to `driver.cjs`: the addon reads `/input/cases.json`, builds all three cases in C, writes `/output/answers.json`, and exits — no JS JSON parse/stringify and no Node teardown on the timed path.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ncycshz&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
