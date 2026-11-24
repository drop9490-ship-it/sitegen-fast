// sitegen-fast: native-first loader. The build itself lives in sitegen.node
// (a C port of solve-js.js, byte-identical); if the addon cannot load on
// this machine, the pure-JS implementation in solve-js.js runs instead.
import { createRequire } from 'node:module';
let native = null;
try { native = createRequire(import.meta.url)('./sitegen.node'); } catch { native = null; }
let run;
if (native && typeof native.run === 'function') run = (input) => native.run(input);
else { const js = await import('./solve-js.js'); run = js.run; }
export { run };
