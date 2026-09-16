// Partial-reception TS carries PMT on 0x1fc8..0x1fcf, often without PID 0 PAT.
// Generic MPEG-TS demuxers need an association before they can discover A/V.
export function crc32Mpeg(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}
export function makePAT(program, pmtPid, continuity = 0) {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x40, 0, 0x10 | (continuity & 15), 0]);
  const section = Uint8Array.from([
    0,
    0xb0,
    13,
    0,
    1,
    0xc1,
    0,
    0,
    program >>> 8,
    program & 255,
    0xe0 | (pmtPid >>> 8),
    pmtPid & 255,
  ]);
  packet.set(section, 5);
  new DataView(packet.buffer).setUint32(17, crc32Mpeg(section));
  return packet;
}
export class ProgramAssociation {
  constructor() {
    this.sections = new Map();
    this.program = null;
    this.continuity = 0;
  }
  push(bytes) {
    for (let at = 0; at + 188 <= bytes.length; at += 188) {
      const packet = bytes.subarray(at, at + 188);
      const pid = ((packet[1] & 31) << 8) | packet[2];
      if (pid < 0x1fc8 || pid > 0x1fcf || packet[1] & 128 || !(packet[3] & 16)) continue;
      let offset = 4 + (packet[3] & 32 ? 1 + packet[4] : 0);
      if (offset >= 188) continue;
      const cc = packet[3] & 15;
      if (packet[1] & 64) {
        offset += 1 + packet[offset];
        this.sections.set(pid, { bytes: [], cc: (cc + 15) & 15 });
      }
      const section = this.sections.get(pid);
      if (!section) continue;
      if (((section.cc + 1) & 15) !== cc) {
        this.sections.delete(pid);
        continue;
      }
      section.cc = cc;
      for (let i = offset; i < 188; i++) section.bytes.push(packet[i]);
      if (section.bytes.length < 3) continue;
      const length = 3 + ((section.bytes[1] & 15) << 8) + section.bytes[2];
      if (length > 1024 || section.bytes[0] !== 2) {
        this.sections.delete(pid);
        continue;
      }
      if (section.bytes.length < length) continue;
      this.sections.delete(pid);
      const pmt = Uint8Array.from(section.bytes.slice(0, length));
      if (length < 16 || !(pmt[5] & 1) || crc32Mpeg(pmt) !== 0) continue;
      let hasVideo = false;
      for (let i = 12 + (((pmt[10] & 15) << 8) | pmt[11]); i + 5 <= length - 4;) {
        if (pmt[i] === 0x1b) hasVideo = true;
        i += 5 + (((pmt[i + 3] & 15) << 8) | pmt[i + 4]);
      }
      if (hasVideo && (!this.program || this.program.pid === pid))
        this.program = { pid, number: (pmt[3] << 8) | pmt[4] };
    }
    if (!this.program) return new Uint8Array();
    // Replace incoming PAT too, so a full-seg first program cannot undo selection.
    const packets = [];
    for (let at = 0; at + 188 <= bytes.length; at += 188)
      if (bytes[at + 1] & 31 || bytes[at + 2]) packets.push(bytes.subarray(at, at + 188));
    const output = new Uint8Array((packets.length + 1) * 188);
    output.set(makePAT(this.program.number, this.program.pid, this.continuity++));
    packets.forEach((packet, i) => output.set(packet, (i + 1) * 188));
    return output;
  }
}
