// makefun-site 1.0.0 driver contract: node /bot/main.ts reads every case
// from /input/cases.json and writes /output/answers.json. The work is done
// by driver.cjs (native C path, with the house JS driver as fallback).
import { createRequire } from 'node:module';
createRequire(import.meta.url)('./driver.cjs');
