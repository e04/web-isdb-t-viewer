// Experimental ISDB-T Mode 3 center-segment analyzer. No decisions alter plotted IQ.
export const SAMPLE_RATE = 2048000;
export const ANALYSIS_RATE = 1024 / 0.001008;
export const FFT_SIZE = 1024;
export const TUNER_OFFSET = 400000;
const TAU = 2 * Math.PI;
const CONTROL = new Set([2693, 2723, 2878, 2941, 2599, 2681, 2798, 2801, 2818, 2836, 2969, 2999]);
const pilots = new Float64Array(432);
let reg = 2047;
for (let k = 0; k < 3024; k++) {
  if (k >= 2592) pilots[k - 2592] = ((1 - 2 * (reg & 1)) * 4) / 3;
  reg = (reg >>> 1) | ((((reg >>> 2) ^ reg) & 1) << 10);
}

export function fft(re, im) {
  const n = re.length;
  if (n !== im.length || n < 2 || n & (n - 1)) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const cr = Math.cos(-TAU / len),
      ci = Math.sin(-TAU / len);
    for (let start = 0; start < n; start += len) {
      let wr = 1,
        wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = start + j,
          b = a + len / 2;
        const vr = re[b] * wr - im[b] * wi,
          vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const next = wr * cr - wi * ci;
        wi = wr * ci + wi * cr;
        wr = next;
      }
    }
  }
}

function spectrum(re, im, sampleRate, offset) {
  const n = 4096,
    power = new Float64Array(n),
    win = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((TAU * i) / n);
    energy += win[i] ** 2;
  }
  const count = Math.min(128, Math.floor(re.length / n));
  for (let j = 0; j < count; j++) {
    const start = Math.floor((j * (re.length - n)) / Math.max(1, count - 1));
    const r = new Float64Array(n),
      q = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      r[i] = re[start + i] * win[i];
      q[i] = im[start + i] * win[i];
    }
    fft(r, q);
    for (let i = 0; i < n; i++) power[i] += r[i] ** 2 + q[i] ** 2;
  }
  const x = new Float32Array(n),
    y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (((i - n / 2) * sampleRate) / n + offset) / 1000;
    y[i] = 10 * Math.log10(Math.max(1e-20, power[(i + n / 2) % n] / (count * energy * sampleRate)));
  }
  return { x, y };
}

// 64-tap windowed-sinc fractional resampler, 1024 precomputed phases.
// Low-pass cutoff .235 cycles/input sample removes energy above output Nyquist.
function resample(re, im, sampleRate) {
  const half = 32,
    phases = 1024,
    taps = 64,
    cutoff = 0.235;
  const table = new Float64Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const d = t - half + 1 - p / phases;
      const sinc = Math.abs(d) < 1e-12 ? 2 * cutoff : Math.sin(TAU * cutoff * d) / (Math.PI * d);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((TAU * d) / half);
      table[p * taps + t] = sinc * w;
      sum += sinc * w;
    }
    for (let t = 0; t < taps; t++) table[p * taps + t] /= sum;
  }
  const ratio = sampleRate / ANALYSIS_RATE,
    length = Math.floor(re.length / ratio);
  const r = new Float64Array(length),
    q = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio,
      base = Math.floor(position);
    const phase = Math.min(phases - 1, Math.floor((position - base) * phases));
    let a = 0,
      b = 0;
    for (let t = 0; t < taps; t++) {
      const j = base + t - half + 1;
      if (j >= 0 && j < re.length) {
        const h = table[phase * taps + t];
        a += re[j] * h;
        b += im[j] * h;
      }
    }
    r[i] = a;
    q[i] = b;
  }
  return [r, q];
}

export function synchronize(re, im) {
  const n = FFT_SIZE,
    size = re.length - n;
  if (size < 10000) throw new Error('Not enough samples for OFDM analysis');
  const pr = new Float64Array(size + 1),
    pi = new Float64Array(size + 1);
  const e1 = new Float64Array(size + 1),
    e2 = new Float64Array(size + 1);
  for (let i = 0; i < size; i++) {
    pr[i + 1] = pr[i] + re[i] * re[i + n] + im[i] * im[i + n];
    pi[i + 1] = pi[i] + re[i] * im[i + n] - im[i] * re[i + n];
    e1[i + 1] = e1[i] + re[i] ** 2 + im[i] ** 2;
    e2[i + 1] = e2[i] + re[i + n] ** 2 + im[i + n] ** 2;
  }
  let best = { score: -1 };
  const candidates = {};
  for (const guard of [256, 128, 64, 32]) {
    const period = n + guard,
      blocks = Math.floor((size - guard + 1) / period);
    const folded = new Float32Array(period);
    for (let i = 0; i < blocks * period; i++) {
      const a = pr[i + guard] - pr[i],
        b = pi[i + guard] - pi[i];
      const denom = Math.sqrt((e1[i + guard] - e1[i]) * (e2[i + guard] - e2[i]));
      folded[i % period] += Math.hypot(a, b) / Math.max(1e-15, denom) / blocks;
    }
    let timing = 0;
    for (let i = 1; i < period; i++) if (folded[i] > folded[timing]) timing = i;
    candidates[guard] = folded[timing];
    if (folded[timing] > best.score) best = { score: folded[timing], guard, timing, folded };
  }
  let a = 0,
    b = 0;
  for (let i = best.timing; i + best.guard <= size; i += n + best.guard) {
    a += pr[i + best.guard] - pr[i];
    b += pi[i + best.guard] - pi[i];
  }
  const cfo = (Math.atan2(b, a) * ANALYSIS_RATE) / (TAU * n),
    spectra = [];
  for (let start = best.timing + best.guard - 8; start + n <= re.length; start += n + best.guard) {
    const r = new Float64Array(n),
      q = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const angle = (-TAU * cfo * (start + i)) / ANALYSIS_RATE,
        c = Math.cos(angle),
        s = Math.sin(angle);
      r[i] = re[start + i] * c - im[start + i] * s;
      q[i] = re[start + i] * s + im[start + i] * c;
    }
    fft(r, q);
    spectra.push([r, q]);
  }
  return {
    spectra,
    folded: best.folded,
    metrics: {
      cpCorrelation: best.score,
      guard: best.guard,
      guardRatio: `1/${n / best.guard}`,
      fractionalCfoHz: cfo,
      guardCandidates: candidates,
    },
  };
}

const bin = (k, offset) => (k - 216 + offset + FFT_SIZE) % FFT_SIZE;
export function equalize(spectra, retainCarriers = false) {
  let bestScore = -1,
    bestOffset = 0,
    bestPhase = 0;
  const searchSymbols = Math.min(100, spectra.length);
  for (let offset = -90; offset <= 90; offset++) {
    for (let phase = 0; phase < 4; phase++) {
      let score = 0;
      for (let j = 0; j < searchSymbols; j++) {
        const [r, q] = spectra[j];
        let cr = 0,
          ci = 0,
          ea = 0,
          eb = 0;
        for (let k = 3 * ((phase + j) % 4); k + 12 < 432; k += 12) {
          const a = bin(k, offset),
            b = bin(k + 12, offset),
            sign = pilots[k] * pilots[k + 12] > 0 ? 1 : -1;
          cr += sign * (r[b] * r[a] + q[b] * q[a]);
          ci += sign * (q[b] * r[a] - r[b] * q[a]);
          ea += r[a] ** 2 + q[a] ** 2;
          eb += r[b] ** 2 + q[b] ** 2;
        }
        score += Math.hypot(cr, ci) / Math.max(1e-15, Math.sqrt(ea * eb));
      }
      score /= searchSymbols;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
        bestPhase = phase;
      }
    }
  }
  const raw = [],
    points = [];
  const carriers = retainCarriers ? new Float32Array(spectra.length * 432 * 2) : null;
  let error = 0,
    count = 0,
    rawEnergy = 0,
    rawCount = 0;
  const stride = Math.max(1, Math.ceil((spectra.length * 432) / 40000));
  for (let j = 0; j < spectra.length; j++) {
    const [r, q] = spectra[j],
      start = 3 * ((bestPhase + j) % 4);
    const amplitude = [],
      angle = [];
    for (let k = start; k < 432; k += 12) {
      const b = bin(k, bestOffset),
        hr = r[b] / pilots[k],
        hi = q[b] / pilots[k];
      amplitude.push(Math.hypot(hr, hi));
      let p = Math.atan2(hi, hr);
      if (angle.length) {
        const prev = angle.at(-1);
        while (p - prev > Math.PI) p -= TAU;
        while (p - prev < -Math.PI) p += TAU;
      }
      angle.push(p);
    }
    const sorted = amplitude.toSorted((a, b) => a - b),
      threshold = sorted[Math.floor(sorted.length / 2)] * 0.15;
    for (let k = 0; k < 432; k++) {
      const b = bin(k, bestOffset),
        vr = r[b],
        vi = q[b];
      rawEnergy += vr * vr + vi * vi;
      rawCount++;
      if ((j * 432 + k) % stride === 0) raw.push(vr, vi);
      if (carriers) {
        const at = Math.max(0, Math.min(amplitude.length - 2, Math.floor((k - start) / 12)));
        const f = (k - start) / 12 - at;
        const amp = Math.max(1e-12, amplitude[at] * (1 - f) + amplitude[at + 1] * f);
        const ph = angle[at] * (1 - f) + angle[at + 1] * f;
        carriers[2 * (j * 432 + k)] = (vr * Math.cos(ph) + vi * Math.sin(ph)) / amp;
        carriers[2 * (j * 432 + k) + 1] = (vi * Math.cos(ph) - vr * Math.sin(ph)) / amp;
      }
      if (
        k <= start ||
        k >= start + 12 * (amplitude.length - 1) ||
        (k - start) % 12 === 0 ||
        CONTROL.has(k + 2592)
      )
        continue;
      const p = Math.floor((k - start) / 12),
        f = ((k - start) % 12) / 12;
      const amp = amplitude[p] * (1 - f) + amplitude[p + 1] * f;
      if (amp <= threshold || amp < 1e-15) continue;
      const phase = angle[p] * (1 - f) + angle[p + 1] * f,
        c = Math.cos(phase),
        s = Math.sin(phase);
      const zr = (vr * c + vi * s) / amp,
        zi = (vi * c - vr * s) / amp;
      error += (Math.abs(zr) - Math.SQRT1_2) ** 2 + (Math.abs(zi) - Math.SQRT1_2) ** 2;
      if (count % stride === 0) points.push(zr, zi);
      count++;
    }
  }
  const scale = Math.sqrt(rawEnergy / Math.max(1, rawCount)) || 1;
  const evm = count ? Math.sqrt(error / count) : null;
  return {
    carriers,
    raw: Float32Array.from(raw, (v) => v / scale),
    points: new Float32Array(points),
    metrics: {
      pilotCoherence: bestScore,
      integerCfoBins: bestOffset,
      firstSpPhase: bestPhase,
      evmPercent: evm === null ? null : 100 * evm,
      merDb: evm > 0 ? -20 * Math.log10(evm) : null,
      dataPoints: count,
    },
  };
}

export function analyzeIQ(
  bytes,
  { sampleRate = SAMPLE_RATE, offset = TUNER_OFFSET, decode = false } = {},
  progress = () => {},
) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length % 2 ||
    bytes.length < sampleRate ||
    bytes.length > 24_576_000
  )
    throw new Error('Select 0.5–6 seconds of unsigned 8-bit I/Q data');
  if (
    !Number.isFinite(sampleRate) ||
    Math.abs(sampleRate - SAMPLE_RATE) > 100 ||
    !Number.isFinite(offset) ||
    Math.abs(offset - TUNER_OFFSET) > 1000
  )
    throw new Error('IQ requires 2.048 MS/s and a +400 kHz tuner offset');
  progress('Spectrum and resampling');
  const skip = Math.round(sampleRate * 0.2),
    size = bytes.length / 2 - skip;
  const re = new Float64Array(size),
    im = new Float64Array(size);
  let mr = 0,
    mi = 0,
    clipped = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0 || bytes[i] === 255) clipped++;
  for (let i = 0; i < size; i++) {
    re[i] = (bytes[2 * (i + skip)] - 127.5) / 128;
    im[i] = (bytes[2 * (i + skip) + 1] - 127.5) / 128;
    mr += re[i];
    mi += im[i];
  }
  mr /= size;
  mi /= size;
  for (let i = 0; i < size; i++) {
    re[i] -= mr;
    im[i] -= mi;
  }
  const psd = spectrum(re, im, sampleRate, offset);
  for (let i = 0; i < size; i++) {
    const phase = (TAU * offset * i) / sampleRate,
      c = Math.cos(phase),
      s = Math.sin(phase),
      a = re[i],
      b = im[i];
    re[i] = a * c - b * s;
    im[i] = a * s + b * c;
  }
  const [r, q] = resample(re, im, sampleRate);
  progress('OFDM synchronization');
  const sync = synchronize(r, q);
  progress('Pilot search and equalization');
  const eq = equalize(sync.spectra, decode);
  const metrics = {
    mode: 3,
    sampleRate,
    offset,
    symbols: sync.spectra.length,
    clippedPercent: (100 * clipped) / bytes.length,
    ...sync.metrics,
    ...eq.metrics,
  };
  metrics.totalCfoHz =
    metrics.fractionalCfoHz + (metrics.integerCfoBins * ANALYSIS_RATE) / FFT_SIZE;
  metrics.locked = metrics.cpCorrelation > 0.5 && metrics.pilotCoherence > 0.8;
  metrics.clearQpsk = metrics.locked && metrics.evmPercent !== null && metrics.evmPercent < 25;
  return {
    carriers: eq.carriers,
    spectrum: psd,
    correlation: sync.folded,
    raw: eq.raw,
    points: eq.points,
    metrics,
  };
}
