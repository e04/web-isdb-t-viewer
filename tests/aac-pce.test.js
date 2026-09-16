import test from 'node:test';
import assert from 'node:assert/strict';
import { aacPceConfig } from '../src/media/aac-pce.js';
// PCE with two front single-channel elements (dual mono), 24 kHz LC core.
// id_syn_ele=5, tag=0, object_type=1, frequency_index=6, front=2.
function fixture(comment = []) {
  const bits =
    '101' +
    '0000' +
    '01' +
    '0110' +
    '0010' +
    '0000' +
    '0000' +
    '00' +
    '000' +
    '0000' +
    '0' +
    '0' +
    '0' +
    '00000' +
    '00001';
  const aligned = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes = Array.from({ length: aligned.length / 8 }, (_, i) =>
    Number.parseInt(aligned.slice(i * 8, i * 8 + 8), 2),
  );
  return Uint8Array.from([...bytes, comment.length, ...comment]);
}
test('PCE audio reports its actual channels instead of zero', () => {
  const result = aacPceConfig({ data: fixture() });
  assert.equal(result.channel_count, 2);
  assert.equal(result.sampling_rate, 24000);
  assert.deepEqual(result.config.slice(0, 2), [0x13, 0x10]);
  assert.equal(result.codec_mimetype, 'mp4a.40.2');
});
test('PCE comments do not affect the channel layout or alter the source access unit', () => {
  const data = fixture([65, 66]),
    original = data.slice();
  const result = aacPceConfig({ data });
  assert.deepEqual(result.config, [0x13, 0x10]);
  assert.deepEqual(data, original);
});
test('incomplete or absent PCE is not silently turned into an invalid ASC', () => {
  assert.throws(() => aacPceConfig({ data: new Uint8Array([0]) }), /Waiting/);
  assert.throws(() => aacPceConfig({ data: new Uint8Array([0xa0]) }), /Truncated/);
});
