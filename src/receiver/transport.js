import { FREQUENCY_PERM, TMCC_H } from './isdb-tables.js';
import { viterbi, rsDecode } from './fec.js';
const TMCC = [2693, 2723, 2878, 2941].map((k) => k - 2592);
const CONTROL = new Set(
  [2693, 2723, 2878, 2941, 2599, 2681, 2798, 2801, 2818, 2836, 2969, 2999].map((k) => k - 2592),
);
const RATE = [1 / 2, 2 / 3, 3 / 4, 5 / 6, 7 / 8];
function field(bits, start, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | bits[start + i];
  return v;
}
export function decodeTMCC(carriers) {
  const symbols = carriers.length / (432 * 2),
    bits = new Uint8Array(symbols),
    frames = [];
  for (let j = 1; j < symbols; j++) {
    let vote = 0;
    for (const k of TMCC) {
      const a = 2 * (j * 432 + k),
        b = a - 864;
      vote += carriers[a] * carriers[b] + carriers[a + 1] * carriers[b + 1];
    }
    bits[j] = vote < 0 ? 1 : 0;
  }
  for (let start = 1; start + 204 <= symbols; start++) {
    const sync = field(bits, start + 1, 16);
    if (sync !== 0x35ee && sync !== 0xca11) continue;
    const frame = bits.subarray(start, start + 204);
    let valid = true;
    for (let j = 0; j < 82 && valid; j++) {
      let s = 0;
      for (let i = 0; i < 192; i++) if (i + j >= 89) s ^= frame[i + j - 89 + 20] * TMCC_H[i];
      if (s) valid = false;
    }
    if (!valid) continue;
    const modulation = field(frame, 28, 3),
      rateIndex = field(frame, 31, 3),
      interleaveIndex = field(frame, 34, 3),
      segments = field(frame, 37, 4);
    frames.push({
      start,
      sync,
      modulation,
      rateIndex,
      interleave: [0, 1, 2, 4][interleaveIndex],
      segments,
      partial: !!frame[27],
    });
  }
  return { frames, bits };
}
export function deinterleave(carriers, firstSpPhase, depth) {
  const symbols = carriers.length / 864,
    frequency = new Float32Array(symbols * 384 * 2);
  for (let j = 0; j < symbols; j++) {
    const positions = [];
    for (let k = 0; k < 432; k++)
      if (k % 12 !== 3 * ((firstSpPhase + j) % 4) && !CONTROL.has(k)) positions.push(k);
    if (positions.length !== 384) throw new Error('ISDB-T data carrier count mismatch');
    for (let k = 0; k < 384; k++) {
      const input = 2 * (j * 432 + positions[FREQUENCY_PERM[k]]),
        output = 2 * (j * 384 + k);
      frequency[output] = carriers[input];
      frequency[output + 1] = carriers[input + 1];
    }
  }
  // Skip the time-interleaver transient, preserving order within each symbol.
  const skip = 95 * depth,
    stream = new Float32Array(Math.max(0, symbols - skip) * 768);
  for (let j = skip; j < symbols; j++)
    for (let k = 0; k < 384; k++) {
      const delay = depth * (95 - ((5 * k) % 96)),
        input = 2 * ((j - delay) * 384 + k),
        output = 2 * ((j - skip) * 384 + k);
      stream[output] = frequency[input];
      stream[output + 1] = frequency[input + 1];
    }
  // QPSK MSB (I) delayed by 120 carriers, LSB (Q) not delayed.
  const soft = new Float32Array(Math.max(0, stream.length - 240));
  for (let k = 120; k < stream.length / 2; k++) {
    soft[2 * (k - 120)] = Math.max(-2, Math.min(2, stream[2 * (k - 120)]));
    soft[2 * (k - 120) + 1] = Math.max(-2, Math.min(2, stream[2 * k + 1]));
  }
  return soft;
}
function pack(bits, shift) {
  const bytes = new Uint8Array(Math.floor((bits.length - shift) / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = field(bits, 8 * i + shift, 8);
  return bytes;
}
export function packetAlignment(bits) {
  let best = { score: 0 };
  for (let shift = 0; shift < 8; shift++) {
    const bytes = pack(bits, shift);
    for (let position = 0; position < 204; position++) {
      let hits = 0,
        total = 0;
      for (let i = position + 204 * 12; i < Math.min(bytes.length, 204 * 150); i += 204) {
        total++;
        if (bytes[i] === 0x47) hits++;
      }
      const score = hits / Math.max(1, total);
      if (score > best.score) best = { score, shift, sync: position, bytes };
    }
  }
  return best;
}
function randomizer(packetCount) {
  let reg = 0xa9;
  const bytes = new Uint8Array(packetCount * 204);
  for (let i = 0; i < bytes.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) {
      const b = ((reg >>> 13) ^ (reg >>> 14)) & 1;
      reg = ((reg << 1) | b) & 0x7fff;
      v = (v << 1) | b;
    }
    bytes[i] = v;
  }
  return bytes;
}
export function decodePackets(alignment, rateIndex) {
  const { bytes, sync } = alignment,
    start = (sync + 1) % 204,
    packets = Math.floor((bytes.length - start) / 204),
    deint = new Uint8Array(packets * 204);
  for (let i = 0; i < deint.length; i++) {
    const branch = i % 12,
      from = i - 12 * 17 * (11 - branch);
    if (from >= 0) deint[i] = bytes[start + from];
  }
  const perFrame = 96 * RATE[rateIndex],
    prbs = randomizer(perFrame);
  const descramble = (packet, phase) => {
    const out = new Uint8Array(204),
      at = packet * 204,
      key = ((packet + phase) % perFrame) * 204;
    out[0] = deint[at + 203];
    for (let b = 0; b < 203; b++) out[b + 1] = deint[at + b] ^ prbs[key + b];
    return out;
  };
  let bestPhase = -1,
    best = 0;
  // Validate frame randomizer phase using RS, never packet sync alone.
  for (let phase = 0; phase < perFrame; phase++) {
    let good = 0;
    for (let p = 12; p < Math.min(packets, 28); p++) {
      const decoded = rsDecode(descramble(p, phase));
      if (decoded && decoded.data[0] === 0x47) good++;
    }
    if (good > best) {
      best = good;
      bestPhase = phase;
    }
  }
  if (bestPhase < 0)
    return {
      bytes: new Uint8Array(),
      validPackets: 0,
      failedPackets: Math.max(0, packets - 12),
      phase: null,
    };
  const output = [],
    stats = { validPackets: 0, failedPackets: 0, correctedBytes: 0, phase: bestPhase };
  for (let p = 12; p < packets; p++) {
    const decoded = rsDecode(descramble(p, bestPhase));
    if (!decoded || decoded.data[0] !== 0x47) {
      stats.failedPackets++;
      continue;
    }
    stats.validPackets++;
    stats.correctedBytes += decoded.corrected;
    output.push(decoded.data);
  }
  const ts = new Uint8Array(output.length * 188);
  output.forEach((p, i) => ts.set(p, i * 188));
  return { bytes: ts, ...stats };
}
export function decodeTransport(carriers, metrics, progress = () => {}) {
  const tmcc = decodeTMCC(carriers);
  const frame = tmcc.frames[0];
  const info = { tmccFrames: tmcc.frames.length, parameters: frame || null };
  if (!frame) return { ...info, bytes: new Uint8Array(), error: 'No parity-validated TMCC frame' };
  if (
    frame.modulation !== 1 ||
    frame.segments !== 1 ||
    !frame.partial ||
    frame.interleave === undefined ||
    frame.rateIndex > 4
  )
    return {
      ...info,
      bytes: new Uint8Array(),
      error: 'Unsupported broadcast: requires partial-reception QPSK, one-segment layer A',
    };
  progress(`Time deinterleaving I=${frame.interleave}`);
  const soft = deinterleave(carriers, metrics.firstSpPhase, frame.interleave);
  let best = { score: 0 };
  // Unknown puncture phase after removing the acquisition transient.
  const puncturePhases = [1, 4, 6, 10, 14][frame.rateIndex];
  for (let phase = 0; phase < puncturePhases; phase++) {
    progress(`Viterbi decoding ${phase + 1}/${puncturePhases}`);
    const bits = viterbi(soft, frame.rateIndex, phase),
      alignment = packetAlignment(bits);
    if (alignment.score > best.score) best = { ...alignment, puncturePhase: phase };
    if (alignment.score > 0.85) break;
  }
  info.syncScore = best.score;
  info.puncturePhase = best.puncturePhase;
  if (best.score < 0.15)
    return { ...info, bytes: new Uint8Array(), error: 'No transport packet synchronization' };
  progress('Byte deinterleaving and RS correction');
  return { ...info, ...decodePackets(best, frame.rateIndex) };
}
