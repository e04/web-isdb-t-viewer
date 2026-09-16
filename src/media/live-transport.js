// A session-scoped source: samples never pass through React state updates.
export class LiveTransport {
  constructor() {
    this.queue = [];
    this.size = 0;
    this.closed = false;
  }
  write(bytes) {
    if (this.closed || !bytes.length) return;
    if (this.listener) this.listener(bytes);
    else {
      this.queue.push(bytes);
      this.size += bytes.length;
      if (this.size > 2 * 1024 * 1024)
        throw new Error('Live player is not consuming transport data');
    }
  }
  subscribe(listener) {
    if (this.closed) return () => {};
    this.listener = listener;
    for (const bytes of this.queue) listener(bytes);
    this.queue = [];
    this.size = 0;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
  close() {
    this.closed = true;
    this.listener = null;
    this.queue = [];
    this.size = 0;
  }
}

const PACKET = 188;
function same(a, ai, b, bi) {
  for (let j = 0; j < PACKET; j++) if (a[ai + j] !== b[bi + j]) return false;
  return true;
}
function hash(bytes, start) {
  let value = 2166136261;
  for (let j = 0; j < PACKET; j++) value = Math.imul(value ^ bytes[start + j], 16777619);
  return value >>> 0;
}
function useful(bytes, start) {
  const pid = ((bytes[start + 1] & 31) << 8) | bytes[start + 2];
  return pid > 31 && pid !== 8191 && bytes[start + 3] & 16;
}

// Match actual RS-validated packet contents, not wrapping continuity counters.
// The rolling IQ window includes the previous window's acquisition transient.
export class TransportJoiner {
  constructor() {
    this.tail = null;
  }
  push(bytes) {
    if (bytes.length % PACKET) throw new Error('Transport packet alignment lost');
    if (!bytes.length) return { bytes, overlap: 0, discontinuity: false };
    let cut = 0,
      discontinuity = false;
    if (this.tail) {
      const index = new Map();
      for (let at = 0; at < bytes.length; at += PACKET) {
        if (!useful(bytes, at)) continue;
        const key = hash(bytes, at);
        if (index.has(key)) index.set(key, -1); // Repeated payload is not a reliable time anchor.
        else index.set(key, at);
      }
      let matches = 0,
        lastNew = -1,
        lastOld = -1;
      for (let at = 0; at < this.tail.length; at += PACKET) {
        if (!useful(this.tail, at)) continue;
        const next = index.get(hash(this.tail, at));
        if (next === undefined || next < 0 || !same(this.tail, at, bytes, next)) continue;
        if (next <= lastNew) {
          matches = 0;
        }
        matches++;
        lastNew = next;
        lastOld = at;
      }
      if (matches >= 3 && lastOld >= this.tail.length - PACKET * 32) {
        cut = lastNew + PACKET;
        // Include any trailing matching PSI/null packets without inventing an anchor.
        for (
          let at = lastOld + PACKET;
          at < this.tail.length && cut < bytes.length && same(this.tail, at, bytes, cut);
          at += PACKET
        )
          cut += PACKET;
      } else discontinuity = true;
    }
    this.tail = bytes.slice(Math.max(0, bytes.length - PACKET * 1024));
    return { bytes: bytes.slice(cut), overlap: cut / PACKET, discontinuity };
  }
}
