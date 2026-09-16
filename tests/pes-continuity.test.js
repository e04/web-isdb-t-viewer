import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptPESSlice } from '../src/media/pes-continuity.js';
const context = () => ({
  pes_slice_queues_: {},
  aac_last_incomplete_data_: new Uint8Array([1]),
  audio_last_sample_pts_: 100,
});
const packet = (demuxer, cc, { pid = 256, start = 0, type = 0x1b, bytes = [1, 2, 3] } = {}) => {
  const data = Uint8Array.from(bytes);
  return acceptPESSlice.call(demuxer, data.buffer, 0, data.length, {
    pid,
    payload_unit_start_indicator: start,
    stream_type: type,
    continuity_conunter: cc,
  });
};
test('lost video packet discards queued PES before the next start can emit it', () => {
  const d = context();
  packet(d, 4, { start: 1 });
  d.pes_slice_queues_[256] = { expected_length: 0, slices: ['damaged video'] };
  packet(d, 6, { start: 1 });
  assert.equal(d.pes_slice_queues_[256], undefined);
});
test('valid counter wrap and interleaved PIDs preserve queued video', () => {
  const d = context();
  packet(d, 15);
  const queue = {};
  d.pes_slice_queues_[256] = queue;
  packet(d, 5, { pid: 257 });
  packet(d, 0);
  assert.equal(d.pes_slice_queues_[256], queue);
});
test('exact retransmissions are ignored; changed payload with repeated counter is a gap', () => {
  const d = context();
  packet(d, 3);
  d.pes_slice_queues_[256] = {};
  assert.equal(packet(d, 3), false);
  assert.ok(d.pes_slice_queues_[256]);
  assert.equal(packet(d, 3, { bytes: [4, 5, 6] }), true);
  assert.equal(d.pes_slice_queues_[256], undefined);
});
test('audio loss clears partial AAC and stale timing without affecting another PID', () => {
  const d = context();
  packet(d, 0, { pid: 257, type: 15 });
  const queue = {};
  d.pes_slice_queues_[256] = queue;
  packet(d, 2, { pid: 257, type: 15 });
  assert.equal(d.aac_last_incomplete_data_, null);
  assert.equal(d.audio_last_sample_pts_, undefined);
  assert.equal(d.pes_slice_queues_[256], queue);
});
