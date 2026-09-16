import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgramInformation } from '../src/receiver/program-information.js';
import { crc32Mpeg } from '../src/media/program-association.js';

const sid = 0x401;
const arib = (value) => [0x0e, 0x89, ...Buffer.from(value)];
const descriptor = (tag, bytes) => [tag, bytes.length, ...bytes];
function section(table, id, body, number = 0, current = true) {
  const bytes = Uint8Array.from([
    table,
    0xb0,
    0,
    id >> 8,
    id & 255,
    current ? 0xc1 : 0xc0,
    number,
    1,
    ...body,
    0,
    0,
    0,
    0,
  ]);
  const length = bytes.length - 3;
  bytes[1] |= length >> 8;
  bytes[2] = length & 255;
  new DataView(bytes.buffer).setUint32(bytes.length - 4, crc32Mpeg(bytes.subarray(0, -4)));
  return bytes;
}
function sdt(id = sid, name = arib('Station')) {
  const d = descriptor(0x48, [0xc0, 0, name.length, ...name]);
  return section(0x42, 1, [
    0,
    1,
    255,
    id >> 8,
    id & 255,
    3,
    0x80 | (d.length >> 8),
    d.length & 255,
    ...d,
  ]);
}
function eit({
  id = sid,
  title = 'News',
  description = 'Today',
  number = 0,
  table = 0x4e,
  current = true,
  empty = false,
} = {}) {
  const name = arib(title),
    summary = arib(description);
  const d = descriptor(0x4d, [0x6a, 0x70, 0x6e, name.length, ...name, summary.length, ...summary]);
  const mjd = 40587 + Math.floor(Date.UTC(2026, 8, 16) / 86400000);
  return section(
    table,
    id,
    [
      0,
      1,
      0,
      1,
      1,
      table,
      ...(empty
        ? []
        : [
            0,
            7,
            mjd >> 8,
            mjd & 255,
            0x20,
            0x30,
            0,
            1,
            0,
            0,
            0x80 | (d.length >> 8),
            d.length & 255,
            ...d,
          ]),
    ],
    number,
    current,
  );
}
function packet(pid, payload, cc = 0, start = true) {
  const bytes = new Uint8Array(188).fill(255);
  const adaptationLength = 183 - payload.length;
  assert.ok(adaptationLength >= 0);
  bytes.set([0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 255, 0x30 | cc, adaptationLength]);
  if (adaptationLength) bytes[5] = 0;
  bytes.set(payload, 5 + adaptationLength);
  return bytes;
}
const single = (pid, bytes, cc = 0) => packet(pid, [0, ...bytes], cc);

test('matches selected service, decodes Japanese station name and present/following with JST times', () => {
  const info = new ProgramInformation();
  // JIS kanji 日本 + katakana テレビ.
  info.push(single(0x11, sdt(sid, [0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x6f, 0x46, 0x6c, 0x53])), null);
  info.push(single(0x27, eit()), null);
  info.push(single(0x27, eit({ number: 1, title: 'Next' }), 1), null);
  const result = info.push(new Uint8Array(), sid);
  assert.equal(result.stationName, '日本テレビ');
  assert.equal(result.current.title, 'News');
  assert.equal(result.current.description, 'Today');
  assert.equal(result.current.start, Date.UTC(2026, 8, 16, 11, 30));
  assert.equal(result.current.end, Date.UTC(2026, 8, 16, 12, 30));
  assert.equal(result.next.title, 'Next');
  assert.equal(info.push(new Uint8Array(), sid + 1).current, null);
});
test('assembles split sections and uses pointer bytes to complete preceding section', () => {
  const info = new ProgramInformation();
  const first = eit(),
    next = eit({ number: 1, title: 'Following' });
  info.push(packet(0x12, [0, ...first.slice(0, 20)], 15), sid);
  const result = info.push(packet(0x12, [first.length - 20, ...first.slice(20), ...next], 0), sid);
  assert.equal(result.current.title, 'News');
  assert.equal(result.next.title, 'Following');
});
test('discards CRC errors, future tables and other-transport events', () => {
  const info = new ProgramInformation();
  const damaged = eit();
  damaged[20] ^= 1;
  for (const [cc, bytes] of [damaged, eit({ current: false }), eit({ table: 0x4f })].entries())
    assert.equal(info.push(single(0x27, bytes, cc), sid).current, null);
});
test('missing packets and transport discontinuities cannot combine fragments', () => {
  const info = new ProgramInformation(),
    bytes = eit();
  const first = packet(0x27, [0, ...bytes.slice(0, 20)], 0);
  info.push(first, sid);
  info.push(first, sid); // duplicate
  assert.equal(info.push(packet(0x27, bytes.slice(20), 2, false), sid).current, null);
  info.push(first, sid);
  info.resetFragments();
  assert.equal(info.push(packet(0x27, bytes.slice(20), 1, false), sid).current, null);
  assert.equal(info.push(single(0x27, bytes, 3), sid).current.title, 'News');
});
test('new present section replaces event; empty section clears it', () => {
  const info = new ProgramInformation();
  info.push(single(0x27, eit()), sid);
  assert.equal(info.push(single(0x27, eit({ title: 'Updated' }), 1), sid).current.title, 'Updated');
  assert.equal(info.push(single(0x27, eit({ empty: true }), 2), sid).current, null);
});
test('NIT provides a station fallback when SDT is absent, and SDT takes priority', () => {
  const info = new ProgramInformation();
  const name = arib('Network');
  const d = descriptor(0xcd, [4, (name.length << 2) | 1, ...name, 0, 1, sid >> 8, sid & 255]);
  const transport = [0, 1, 0, 1, 0xf0, d.length, ...d];
  const nit = section(0x40, 1, [0xf0, 0, 0xf0, transport.length, ...transport]);
  assert.equal(info.push(single(0x10, nit), sid).stationName, 'Network');
  assert.equal(info.push(single(0x11, sdt()), sid).stationName, 'Station');
});
