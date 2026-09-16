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
