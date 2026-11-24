'use strict';
// Fast driver: the native addon reads /input/cases.json, builds every case
// in C and writes /output/answers.json, then exits the process group
// directly (no Node teardown). Falls back to the house driver if the
// addon cannot load on this machine.
let native = null;
try { native = require('./sitegen.node'); } catch (e) { native = null; }
if (native && typeof native.main === 'function') native.main(); // never returns
(async () => {
  const { readFileSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { setFlagsFromString } = require('node:v8');
  setFlagsFromString('--no-incremental-marking');
  const { run } = await import('./solve.js');
  const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
  const answers = [];
  for (const c of cases) answers.push(run(c.input));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
})();
