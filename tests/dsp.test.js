import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fft, synchronize, equalize, analyzeIQ, ANALYSIS_RATE } from '../src/receiver/dsp.js';
import { channels } from '../src/receiver/channels.js';

test('FFT resolves a known complex tone', () => {
  const r = Float64Array.from({ length: 1024 }, (_, i) => Math.cos((2 * Math.PI * 17 * i) / 1024));
  const q = Float64Array.from({ length: 1024 }, (_, i) => Math.sin((2 * Math.PI * 17 * i) / 1024));
  fft(r, q);
  assert.ok(Math.abs(r[17] - 1024) < 1e-8);
  assert.ok(Math.abs(q[17]) < 1e-8);
  assert.ok(r.every((v, i) => i === 17 || Math.abs(v) < 1e-8));
});
let seed = 42;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function synthetic() {
  const symbols = 160,
    n = 1024,
    g = 128,
    lead = 73,
    r = new Float64Array(lead + symbols * (n + g)),
    q = new Float64Array(r.length);
  const pilot = [];
  let reg = 2047;
  for (let k = 0; k < 3024; k++) {
    pilot[k] = ((1 - 2 * (reg & 1)) * 4) / 3;
    reg = (reg >>> 1) | ((((reg >>> 2) ^ reg) & 1) << 10);
  }
  for (let j = 0; j < symbols; j++) {
    const a = new Float64Array(n),
      b = new Float64Array(n);
    for (let k = 2592; k < 3024; k++) {
      const bin = (k - 2808 + n) % n;
      if (k % 12 === 3 * (j % 4)) {
        a[bin] = pilot[k];
        b[bin] = 0;
      } else {
        a[bin] = (random() > 0.5 ? 1 : -1) * Math.SQRT1_2;
        b[bin] = (random() > 0.5 ? 1 : -1) * Math.SQRT1_2;
      }
    }
    for (let i = 0; i < n; i++) b[i] *= -1;
    fft(a, b);
    for (let i = 0; i < n + g; i++) {
      const k = (i + n - g) % n,
        t = lead + j * (n + g) + i;
      r[t] = a[k] / n;
      q[t] = -b[k] / n;
    }
  }
  for (let i = r.length - 1; i >= 3; i--) {
    r[i] += 0.2 * r[i - 3];
    q[i] += 0.2 * q[i - 3];
  }
  const cfo = (7 * ANALYSIS_RATE) / 1024 + 123;
  for (let i = 0; i < r.length; i++) {
    const c = Math.cos((2 * Math.PI * cfo * i) / ANALYSIS_RATE),
      s = Math.sin((2 * Math.PI * cfo * i) / ANALYSIS_RATE),
      a = r[i],
      b = q[i];
    r[i] = a * c - b * s + (random() - 0.5) * 0.0006;
    q[i] = a * s + b * c + (random() - 0.5) * 0.0006;
  }
  return [r, q];
}
test('recovers guard interval, CFO and QPSK through multipath', () => {
  const [r, q] = synthetic(),
    s = synchronize(r, q),
    e = equalize(s.spectra);
  assert.equal(s.metrics.guard, 128);
  assert.ok(Math.abs(s.metrics.fractionalCfoHz - 123) < 3);
  assert.equal(e.metrics.integerCfoBins, 7);
  assert.ok(e.metrics.evmPercent < 10);
});
test('noise does not claim synchronization and DC does not invent QPSK', () => {
  const r = Float64Array.from({ length: 180000 }, () => random() - 0.5),
    q = Float64Array.from(r, () => random() - 0.5);
  const s = synchronize(r, q),
    e = equalize(s.spectra);
  assert.ok(s.metrics.cpCorrelation < 0.3);
  assert.ok(e.metrics.pilotCoherence < 0.5);
  const dc = analyzeIQ(new Uint8Array(2048000).fill(128));
  assert.equal(dc.metrics.locked, false);
  assert.equal(dc.metrics.clearQpsk, false);
  assert.equal(dc.metrics.evmPercent, null);
});
const fixture = 'experiments/one-seg/results/ch27-g28.cu8';
test('real capture agrees with Python reference', { skip: !existsSync(fixture) }, () => {
  const m = analyzeIQ(readFileSync(fixture)).metrics;
  assert.equal(m.guard, 128);
  assert.equal(m.integerCfoBins, 1);
  assert.ok(Math.abs(m.cpCorrelation - 0.971948) < 0.002);
  assert.ok(Math.abs(m.evmPercent - 20.14365) < 0.1);
  assert.ok(Math.abs(m.merDb - 13.917235) < 0.1);
});
test('UHF channel frequencies and malformed IQ', () => {
  assert.equal(channels.length, 40);
  assert.equal(new Set(channels.map((c) => c.channel)).size, 40);
  assert.ok(Math.abs(channels.find((c) => c.channel === 27).center - 557142857.142857) < 0.001);
  assert.ok(Math.abs(channels.find((c) => c.channel === 16).center - 491142857.142857) < 0.001);
  assert.throws(() => analyzeIQ(new Uint8Array(100)));
  assert.throws(() => analyzeIQ(new Uint8Array(2048001)));
});
