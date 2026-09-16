// K=7 convolutional and shortened RS(204,188) decoding.
const parity = (x) => {
  x ^= x >>> 4;
  x ^= x >>> 2;
  x ^= x >>> 1;
  return x & 1;
};
export const PUNCTURE = [
  [1, 1],
  [1, 1, 0, 1],
  [1, 1, 0, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 0, 1, 1, 0],
  [1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0],
];
// Soft values: positive means bit 0, zero is an erasure.
export function viterbi(soft, rateIndex = 1, phase = 0) {
  const pattern = PUNCTURE[rateIndex];
  if (!pattern) throw new Error('Unsupported convolutional code rate');
  const ones = pattern.reduce((a, b) => a + b, 0),
    steps = Math.floor(((soft.length / ones) * pattern.length) / 2);
  const decisions = new Uint8Array(steps * 8),
    bits = new Uint8Array(steps);
  let old = new Float64Array(64),
    next = new Float64Array(64),
    input = 0,
    patternIndex = phase;
  const signA = new Int8Array(128),
    signB = new Int8Array(128);
  for (let i = 0; i < 128; i++) {
    signA[i] = 1 - 2 * parity(i & 0x4f);
    signB[i] = 1 - 2 * parity(i & 0x6d);
  }
  let used = 0;
  for (let t = 0; t < steps; t++) {
    const a = pattern[patternIndex++ % pattern.length] ? soft[input++] : 0;
    const b = pattern[patternIndex++ % pattern.length] ? soft[input++] : 0;
    if (input > soft.length) break;
    let max = -Infinity;
    for (let state = 0; state < 64; state++) {
      const lo = state >>> 1,
        hi = lo + 32;
      const m0 = old[lo] + a * signA[state] + b * signB[state];
      const m1 = old[hi] + a * signA[state + 64] + b * signB[state + 64];
      if (m1 > m0) {
        next[state] = m1;
        decisions[t * 8 + (state >>> 3)] |= 1 << (state & 7);
      } else next[state] = m0;
      if (next[state] > max) max = next[state];
    }
    if (t % 256 === 0) for (let i = 0; i < 64; i++) next[i] -= max;
    [old, next] = [next, old];
    used++;
  }
  let state = 0;
  for (let i = 1; i < 64; i++) if (old[i] > old[state]) state = i;
  for (let t = used - 1; t >= 0; t--) {
    bits[t] = state & 1;
    state = (state >>> 1) | (((decisions[t * 8 + (state >>> 3)] >>> (state & 7)) & 1) << 5);
  }
  return bits.subarray(0, used);
}
const exp = new Uint8Array(510),
  log = new Uint8Array(256);
let gf = 1;
for (let i = 0; i < 255; i++) {
  exp[i] = gf;
  log[gf] = i;
  gf <<= 1;
  if (gf & 256) gf ^= 0x11d;
}
for (let i = 255; i < 510; i++) exp[i] = exp[i - 255];
const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
const div = (a, b) => {
  if (!b) throw new Error('GF division by zero');
  return a ? exp[(log[a] - log[b] + 255) % 255] : 0;
};
const evaluate = (coeff, x) => {
  let y = 0;
  for (let i = coeff.length - 1; i >= 0; i--) y = mul(y, x) ^ coeff[i];
  return y;
};
export function syndromes(data) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let v = 0;
    for (const b of data) v = mul(v, exp[i]) ^ b;
    s[i] = v;
  }
  return s;
}
export function rsDecode(input) {
  if (input.length !== 204) throw new Error('RS expects 204 bytes');
  const s = syndromes(input);
  if (s.every((v) => !v)) return { data: input.slice(0, 188), corrected: 0 };
  let c = new Uint8Array(17),
    b = new Uint8Array(17),
    length = 0,
    m = 1,
    last = 1;
  c[0] = b[0] = 1;
  for (let n = 0; n < 16; n++) {
    let d = s[n];
    for (let i = 1; i <= length; i++) d ^= mul(c[i], s[n - i]);
    if (!d) {
      m++;
      continue;
    }
    const old = c.slice(),
      scale = div(d, last);
    for (let i = 0; i + m < 17; i++) c[i + m] ^= mul(scale, b[i]);
    if (2 * length <= n) {
      length = n + 1 - length;
      b = old;
      last = d;
      m = 1;
    } else m++;
  }
  if (!length || length > 8) return null;
  const positions = [],
    xs = [];
  for (let p = 0; p < 204; p++) {
    const power = 203 - p,
      x = exp[power];
    if (evaluate(c.subarray(0, length + 1), exp[(255 - power) % 255]) === 0) {
      positions.push(p);
      xs.push(x);
    }
  }
  if (positions.length !== length) return null;
  // Solve the small Vandermonde system for error magnitudes (syndrome S_0..S_t-1).
  const a = Array.from({ length }, (_, row) => {
    const v = new Uint8Array(length + 1);
    for (let col = 0; col < length; col++) v[col] = row === 0 ? 1 : exp[(log[xs[col]] * row) % 255];
    v[length] = s[row];
    return v;
  });
  for (let col = 0; col < length; col++) {
    let pivot = col;
    while (pivot < length && !a[pivot][col]) pivot++;
    if (pivot === length) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = col; j <= length; j++) a[col][j] = div(a[col][j], d);
    for (let row = 0; row < length; row++)
      if (row !== col) {
        const f = a[row][col];
        for (let j = col; j <= length; j++) a[row][j] ^= mul(f, a[col][j]);
      }
  }
  const fixed = input.slice();
  for (let i = 0; i < length; i++) fixed[positions[i]] ^= a[i][length];
  if (syndromes(fixed).some((v) => v)) return null;
  return { data: fixed.slice(0, 188), corrected: length };
}
// Used for independent round-trip fixtures; encoder uses polynomial long division.
export function rsEncode(data) {
  if (data.length !== 188) throw new Error('RS payload size');
  let generator = [1];
  for (let root = 0; root < 16; root++) {
    const next = new Uint8Array(generator.length + 1);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= mul(generator[j], exp[root]);
    }
    generator = next;
  }
  const work = new Uint8Array(204);
  work.set(data);
  for (let i = 0; i < 188; i++) {
    const scale = work[i];
    if (scale) for (let j = 0; j < generator.length; j++) work[i + j] ^= mul(scale, generator[j]);
  }
  work.set(data);
  return work;
}
