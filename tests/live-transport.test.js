import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTransport, TransportJoiner } from '../src/media/live-transport.js';
import { crc32Mpeg, makePAT, ProgramAssociation } from '../src/media/program-association.js';
const packets = (from, count) => {
  const bytes = new Uint8Array(count * 188);
  for (let i = 0; i < count; i++) {
    const at = i * 188,
      id = from + i;
    bytes.set([0x47, 0x01, 0, 0x10 | (id & 15)], at);
    new DataView(bytes.buffer).setUint32(at + 4, id);
  }
  return bytes;
};
test('overlapping capture windows deliver each packet exactly once', () => {
  const joiner = new TransportJoiner();
  const first = joiner.push(packets(0, 100));
  const second = joiner.push(packets(50, 100));
  const third = joiner.push(packets(100, 100));
  assert.equal(second.overlap, 50);
  assert.equal(second.discontinuity, false);
  assert.deepEqual(
    new Uint8Array(Buffer.concat([first.bytes, second.bytes, third.bytes])),
    packets(0, 200),
  );
});
test('continuity counter wrap is not treated as matching content', () => {
  const joiner = new TransportJoiner();
  joiner.push(packets(0, 64));
  const next = joiner.push(packets(1024, 64));
  assert.equal(next.discontinuity, true);
  assert.equal(next.overlap, 0);
});
test('overlap can be recovered despite missing RS-rejected packets', () => {
  const joiner = new TransportJoiner();
  joiner.push(packets(0, 100));
  const bytes = Buffer.concat([packets(50, 10), packets(61, 89)]);
  const next = joiner.push(bytes);
  assert.equal(next.discontinuity, false);
  assert.deepEqual(new Uint8Array(next.bytes), packets(100, 50));
});
test('a late subscriber receives queued transport and closed sessions release it', () => {
  const source = new LiveTransport(),
    received = [];
  source.write(packets(0, 3));
  const unsubscribe = source.subscribe((bytes) => received.push(bytes));
  source.write(packets(3, 2));
  unsubscribe();
  source.write(packets(5, 1));
  source.close();
  source.write(packets(6, 1));
  assert.equal(received.length, 2);
  assert.equal(source.queue.length, 0);
});
test('MPEG CRC matches its published check value and generated PAT verifies', () => {
  assert.equal(crc32Mpeg(new TextEncoder().encode('123456789')), 0x0376e6e7);
  const packet = makePAT(42, 0x1fc8, 17);
  assert.equal(crc32Mpeg(packet.subarray(5, 21)), 0);
  assert.equal(packet[3] & 15, 1);
  assert.equal(packet[13], 0);
  assert.equal(packet[14], 42);
});
function pmtPackets(descriptors = 0) {
  const length = 18 + descriptors;
  const pmt = Uint8Array.from([
    2,
    0xb0 | (length >>> 8),
    length & 255,
    0,
    42,
    0xc1,
    0,
    0,
    0xe1,
    1,
    0xf0,
    0,
    0x1b,
    0xe1,
    1,
    0xf0 | (descriptors >>> 8),
    descriptors & 255,
    ...Array.from({ length: descriptors }, () => 0),
  ]);
  const section = new Uint8Array(pmt.length + 4);
  section.set(pmt);
  new DataView(section.buffer).setUint32(pmt.length, crc32Mpeg(pmt));
  const out = [];
  let pos = 0;
  while (pos < section.length) {
    const packet = new Uint8Array(188).fill(255),
      first = pos === 0,
      offset = first ? 5 : 4;
    packet.set([0x47, first ? 0x5f : 0x1f, 0xc8, 0x10 | out.length]);
    if (first) packet[4] = 0;
    packet.set(section.subarray(pos, pos + 188 - offset), offset);
    pos += 188 - offset;
    out.push(packet);
  }
  return out;
}
test('one-seg PMT without PAT becomes discoverable to a generic demuxer', () => {
  const association = new ProgramAssociation(),
    pmt = pmtPackets()[0];
  const result = association.push(pmt);
  assert.deepEqual(association.program, { pid: 0x1fc8, number: 42 });
  assert.equal(result.length, 376);
  assert.equal(result[1] & 31, 0);
  assert.equal(result[2], 0);
  assert.deepEqual(result.subarray(188), pmt);
});
test('PMT sections split over packets and writes are assembled before selection', () => {
  const association = new ProgramAssociation(),
    [first, second] = pmtPackets(200);
  assert.equal(association.push(first).length, 0);
  assert.equal(association.push(second).length, 376);
  assert.equal(association.program.number, 42);
});
test('corrupt PMT is rejected rather than inventing a service', () => {
  const association = new ProgramAssociation(),
    pmt = pmtPackets()[0];
  pmt[10] ^= 4;
  assert.equal(association.push(pmt).length, 0);
  assert.equal(association.program, null);
});
