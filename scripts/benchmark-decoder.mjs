import { performance } from 'node:perf_hooks';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directories = process.argv.slice(2);
if (!directories.length) directories.push('.');
const modules = await Promise.all(
  directories.map(async (directory) => {
    const root = resolve(directory);
    return {
      name: basename(root),
      dsp: await import(pathToFileURL(join(root, 'src', 'receiver', 'dsp.js'))),
      fec: await import(pathToFileURL(join(root, 'src', 'receiver', 'fec.js'))),
    };
  }),
);
let seed = 42;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const bytes = Uint8Array.from({ length: 24576000 }, () => 96 + Math.floor(random() * 64));
// A representative Mode 3, guard 1/8, I=4 transport workload, rate 2/3.
// Noise IQ does not lock: exercise Viterbi separately instead of omitting FEC.
const soft = Float32Array.from({ length: (5113 - 95 * 4) * 768 - 240 }, () => (random() - 0.5) * 2);
const results = [];
for (let round = 0; round < 4; round++) {
  const order = round % 2 ? [...modules].reverse() : modules;
  for (const { name, dsp, fec } of order) {
    const start = performance.now();
    dsp.analyzeIQ(bytes, { decode: true });
    const dspEnd = performance.now();
    fec.viterbi(soft, 1, 0);
    const end = performance.now();
    const result = {
      name,
      round,
      dspMs: dspEnd - start,
      viterbiMs: end - dspEnd,
      totalMs: end - start,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
const median = (values) => values.sort((a, b) => a - b)[1];
for (const { name } of modules) {
  const runs = results.filter((result) => result.name === name && result.round > 0);
  console.log(
    JSON.stringify({
      name,
      measuredRuns: 3,
      dspMs: median(runs.map((run) => run.dspMs)),
      viterbiMs: median(runs.map((run) => run.viterbiMs)),
      totalMs: median(runs.map((run) => run.totalMs)),
    }),
  );
}
