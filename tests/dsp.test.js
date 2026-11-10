import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  fft,
  synchronize,
  equalize,
  analyzeIQ,
  frequencyShift,
  resample,
  SAMPLE_RATE,
  ANALYSIS_RATE,
} from '../src/receiver/dsp.js';
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
function synthetic(g = 128) {
  const symbols = 160,
    n = 1024,
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

test('recursive frequency shift matches direct trigonometry throughout six-second windows', () => {
  for (const frequency of [
    -401000, -400000, -399000, -251.8143, 0, 399000, 399935.82589286566, 400000, 401000,
  ]) {
    for (const sampleRate of [SAMPLE_RATE - 100, SAMPLE_RATE, SAMPLE_RATE + 100]) {
      for (const firstSample of [0, 6 * SAMPLE_RATE - 8192]) {
        const r = Float64Array.from({ length: 4097 }, () => random() - 0.5),
          q = Float64Array.from(r, () => random() - 0.5),
          originalR = r.slice(),
          originalQ = q.slice();
        frequencyShift(r, q, frequency, sampleRate, firstSample);
        for (let i = 0; i < r.length; i++) {
          const phase = (2 * Math.PI * frequency * (firstSample + i)) / sampleRate,
            c = Math.cos(phase),
            s = Math.sin(phase);
          assert.ok(Math.abs(r[i] - (originalR[i] * c - originalQ[i] * s)) < 1e-8);
          assert.ok(Math.abs(q[i] - (originalR[i] * s + originalQ[i] * c)) < 1e-8);
          assert.ok(
            Math.abs(r[i] ** 2 + q[i] ** 2 - originalR[i] ** 2 - originalQ[i] ** 2) < 1e-11,
          );
        }
      }
    }
  }
});

test('bounded FIR loop matches the original zero-padded sum including both edges', () => {
  for (const sampleRate of [SAMPLE_RATE - 100, SAMPLE_RATE, SAMPLE_RATE + 100]) {
    const r = Float64Array.from({ length: 4097 }, () => random() - 0.5),
      q = Float64Array.from(r, () => random() - 0.5);
    const [actualR, actualQ] = resample(r, q, sampleRate);
    const ratio = sampleRate / ANALYSIS_RATE;
    for (let i = 0; i < actualR.length; i++) {
      const position = i * ratio,
        base = Math.floor(position),
        phase = Math.min(1023, Math.floor((position - base) * 1024)),
        coefficients = new Float64Array(64);
      let sum = 0;
      for (let t = 0; t < 64; t++) {
        const d = t - 31 - phase / 1024;
        const sinc = Math.abs(d) < 1e-12 ? 0.47 : Math.sin(2 * Math.PI * 0.235 * d) / (Math.PI * d);
        const window =
          0.42 + 0.5 * Math.cos((Math.PI * d) / 32) + 0.08 * Math.cos((2 * Math.PI * d) / 32);
        coefficients[t] = sinc * window;
        sum += coefficients[t];
      }
      let expectedR = 0,
        expectedQ = 0;
      for (let t = 0; t < 64; t++) {
        const at = base + t - 31;
        if (at >= 0 && at < r.length) {
          const h = coefficients[t] / sum;
          expectedR += r[at] * h;
          expectedQ += q[at] * h;
        }
      }
      assert.equal(actualR[i], expectedR);
      assert.equal(actualQ[i], expectedQ);
    }
  }
});

function referenceSynchronization(re, im) {
  const size = re.length - 1024;
  const pr = new Float64Array(size + 1),
    pi = new Float64Array(size + 1),
    e1 = new Float64Array(size + 1),
    e2 = new Float64Array(size + 1);
  for (let i = 0; i < size; i++) {
    pr[i + 1] = pr[i] + re[i] * re[i + 1024] + im[i] * im[i + 1024];
    pi[i + 1] = pi[i] + re[i] * im[i + 1024] - im[i] * re[i + 1024];
    e1[i + 1] = e1[i] + re[i] ** 2 + im[i] ** 2;
    e2[i + 1] = e2[i] + re[i + 1024] ** 2 + im[i + 1024] ** 2;
  }
  let best = { score: -1 };
  for (const guard of [256, 128, 64, 32]) {
    const period = 1024 + guard,
      blocks = Math.floor((size - guard + 1) / period),
      folded = new Float32Array(period);
    for (let i = 0; i < blocks * period; i++) {
      const a = pr[i + guard] - pr[i],
        b = pi[i + guard] - pi[i],
        denom = Math.sqrt((e1[i + guard] - e1[i]) * (e2[i + guard] - e2[i]));
      folded[i % period] += Math.hypot(a, b) / Math.max(1e-15, denom) / blocks;
    }
    let timing = 0;
    for (let i = 1; i < period; i++) if (folded[i] > folded[timing]) timing = i;
    if (folded[timing] > best.score) best = { guard, timing, folded, score: folded[timing] };
  }
  let a = 0,
    b = 0;
  for (let i = best.timing; i + best.guard <= size; i += 1024 + best.guard) {
    a += pr[i + best.guard] - pr[i];
    b += pi[i + best.guard] - pi[i];
  }
  const cfo = (Math.atan2(b, a) * ANALYSIS_RATE) / (2 * Math.PI * 1024),
    spectra = [];
  for (
    let start = best.timing + best.guard - 8;
    start + 1024 <= re.length;
    start += 1024 + best.guard
  ) {
    const r = new Float64Array(1024),
      q = new Float64Array(1024);
    for (let i = 0; i < 1024; i++) {
      const phase = (-2 * Math.PI * cfo * (start + i)) / ANALYSIS_RATE,
        c = Math.cos(phase),
        s = Math.sin(phase);
      r[i] = re[start + i] * c - im[start + i] * s;
      q[i] = re[start + i] * s + im[start + i] * c;
    }
    fft(r, q);
    spectra.push([r, q]);
  }
  return { ...best, cfo, spectra };
}

test('optimized synchronization preserves all guard choices, CFO and complex spectra', () => {
  for (const guard of [32, 64, 128, 256]) {
    const [r, q] = synthetic(guard),
      expected = referenceSynchronization(r, q),
      actual = synchronize(r, q);
    assert.equal(actual.metrics.guard, guard);
    assert.equal(actual.metrics.guard, expected.guard);
    assert.ok(Math.abs(actual.metrics.cpCorrelation - expected.score) < 1e-6);
    assert.ok(Math.abs(actual.metrics.fractionalCfoHz - expected.cfo) < 1e-9);
    assert.equal(actual.spectra.length, expected.spectra.length);
    for (let j = 0; j < actual.spectra.length; j++)
      for (let axis = 0; axis < 2; axis++)
        for (let i = 0; i < 1024; i++)
          assert.ok(Math.abs(actual.spectra[j][axis][i] - expected.spectra[j][axis][i]) < 1e-8);
  }
});
