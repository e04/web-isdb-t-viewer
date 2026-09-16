import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitH264AccessUnits, dispatchH264AccessUnits } from '../src/media/h264-access-units.js';

test('five pictures in one PES become separate access units without losing bytes', () => {
  const data = Uint8Array.from([
    0,
    0,
    0,
    1,
    7,
    80,
    ...Array.from({ length: 5 }, (_, i) => [
      0,
      0,
      1,
      9,
      16,
      0,
      0,
      0,
      1,
      i === 0 ? 5 : 1,
      128 + i,
    ]).flat(),
  ]);
  const units = splitH264AccessUnits(data);
  assert.equal(units.length, 5);
  assert.deepEqual(Uint8Array.from(units.flatMap((unit) => Array.from(unit))), data);
  const samples = [];
  const demux = {
    video_metadata_: {},
    parseH264Payload(bytes, pts, dts, position, randomAccess) {
      samples.push({ bytes, pts, dts, position, randomAccess });
      this.video_metadata_.details = { frame_rate: { fps_num: 30000, fps_den: 2002 } };
    },
  };
  assert.equal(dispatchH264AccessUnits.call(demux, data, 90000, 90000, 188, 1), true);
  assert.deepEqual(
    samples.map((s) => s.pts),
    [90000, 96006, 102012, 108018, 114024],
  );
  assert.deepEqual(
    samples.map((s) => s.randomAccess),
    [1, 0, 0, 0, 0],
  );
  assert.equal(samples.at(-1).dts, 114024);
});
test('single picture and missing AUD remain on the original parser path', () => {
  for (const data of [
    new Uint8Array([0, 0, 1, 9, 16, 0, 0, 1, 1, 128]),
    new Uint8Array([0, 0, 1, 1, 128]),
  ]) {
    assert.equal(splitH264AccessUnits(data).length, 1);
    assert.equal(dispatchH264AccessUnits.call({}, data, 0, 0, 0, 0), false);
  }
});
test('joining between keyframes waits for SPS instead of throwing', () => {
  const data = Uint8Array.from([0, 0, 1, 9, 16, 0, 0, 1, 1, 128, 0, 0, 1, 9, 16, 0, 0, 1, 1, 129]);
  const demux = {
    video_metadata_: {},
    video_init_segment_dispatched_: false,
    parseH264Payload() {},
  };
  assert.equal(dispatchH264AccessUnits.call(demux, data, 0, 0, 0, 0), true);
  demux.video_init_segment_dispatched_ = true;
  assert.throws(() => dispatchH264AccessUnits.call(demux, data, 0, 0, 0, 0), /SPS frame timing/);
});
