import test from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode, viterbi, PUNCTURE } from '../src/receiver/fec.js';
import { decodeTransport } from '../src/receiver/transport.js';

test('RS(204,188) corrects up to eight damaged bytes', () => {
  const source = Uint8Array.from({ length: 188 }, (_, i) => (i * 37 + 11) % 256);
  source[0] = 0x47;
  for (let errors = 0; errors <= 8; errors++) {
    const encoded = rsEncode(source);
    for (let i = 0; i < errors; i++) encoded[i * 23] ^= 123;
    const decoded = rsDecode(encoded);
    assert.ok(decoded);
    assert.deepEqual(decoded.data, source);
    assert.equal(decoded.corrected, errors);
  }
});
test('RS rejects an uncorrectable packet', () => {
  const encoded = rsEncode(new Uint8Array(188));
  for (let i = 0; i < 20; i++) encoded[i * 7] ^= i + 1;
  assert.equal(rsDecode(encoded), null);
});
test('no TMCC lock cannot produce transport bytes', () => {
  const result = decodeTransport(new Float32Array(864 * 210), { firstSpPhase: 0 });
  assert.equal(result.bytes.length, 0);
  assert.equal(result.tmccFrames, 0);
  assert.match(result.error, /TMCC/);
});

test('Viterbi restores punctured convolutional data at all five rates', () => {
  const parity = (value) => {
    let result = 0;
    for (; value; value >>>= 1) result ^= value & 1;
    return result;
  };
  const bits = Uint8Array.from({ length: 1024 }, (_, i) =>
    i < 1018 ? (((i * 31) ^ (i * i)) >>> 3) & 1 : 0,
  );
  const encoded = [];
  let register = 0;
  for (const bit of bits) {
    register = ((register << 1) | bit) & 127;
    encoded.push(parity(register & 0x4f), parity(register & 0x6d));
  }
  for (let rate = 0; rate < 5; rate++) {
    const pattern = PUNCTURE[rate];
    const soft = Float32Array.from(
      encoded.filter((_, i) => pattern[i % pattern.length]),
      (bit) => (bit ? -1 : 1),
    );
    const decoded = viterbi(soft, rate);
    assert.deepEqual(decoded, bits.subarray(0, decoded.length));
  }
});

function referenceViterbi(soft, rateIndex, phase) {
  const pattern = PUNCTURE[rateIndex],
    ones = pattern.reduce((a, b) => a + b, 0),
    steps = Math.floor(((soft.length / ones) * pattern.length) / 2),
    decisions = new Uint8Array(steps * 8),
    bits = new Uint8Array(steps),
    sa = new Int8Array(128),
    sb = new Int8Array(128);
  const parity = (value) => {
    let bit = 0;
    for (; value; value >>>= 1) bit ^= value & 1;
    return bit;
  };
  for (let i = 0; i < 128; i++) {
    sa[i] = 1 - 2 * parity(i & 0x4f);
    sb[i] = 1 - 2 * parity(i & 0x6d);
  }
  let old = new Float64Array(64),
    next = new Float64Array(64),
    input = 0,
    patternIndex = phase,
    used = 0;
  for (let t = 0; t < steps; t++) {
    const a = pattern[patternIndex++ % pattern.length] ? soft[input++] : 0,
      b = pattern[patternIndex++ % pattern.length] ? soft[input++] : 0;
    if (input > soft.length) break;
    let max = -Infinity;
    for (let state = 0; state < 64; state++) {
      const lo = state >>> 1,
        m0 = old[lo] + a * sa[state] + b * sb[state],
        m1 = old[lo + 32] + a * sa[state + 64] + b * sb[state + 64];
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

test('packed Viterbi decisions match the original at every rate and puncture phase', () => {
  let seed = 42;
  for (let rate = 0; rate < 5; rate++) {
    for (let phase = 0; phase < PUNCTURE[rate].length; phase++) {
      for (const kind of ['random', 'ties']) {
        const soft = Float32Array.from({ length: 4097 }, () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return kind === 'ties' ? (seed % 3) - 1 : (seed / 2 ** 32 - 0.5) * 4;
        });
        assert.deepEqual(viterbi(soft, rate, phase), referenceViterbi(soft, rate, phase));
      }
    }
  }
  assert.deepEqual(viterbi(new Float32Array()), new Uint8Array());
  assert.deepEqual(viterbi(new Float32Array(4096)), referenceViterbi(new Float32Array(4096), 1, 0));
});
