import { readSection } from 'arib-mmt-tlv-ts/ts/si.js';
import { decodeSIText } from 'arib-mmt-tlv-ts/ts/si-text-decoder.js';

const PIDS = new Set([0x10, 0x11, 0x12, 0x26, 0x27]);
const text = (bytes) => decodeSIText(bytes).trim();
function duration(value) {
  if (value == null) return null;
  const parts = [value >>> 16, (value >>> 8) & 255, value & 255];
  if (parts.some((part) => (part & 15) > 9 || part >>> 4 > 9)) return null;
  const [hours, minutes, seconds] = parts.map((part) => (part >>> 4) * 10 + (part & 15));
  return minutes < 60 && seconds < 60 ? (hours * 3600 + minutes * 60 + seconds) * 1000 : null;
}
function eventInfo(event) {
  if (!event) return null;
  const short =
    event.descriptors.find((d) => d.tag === 'shortEvent' && d.iso639LanguageCode === 0x6a706e) ??
    event.descriptors.find((d) => d.tag === 'shortEvent');
  const time = event.startTime;
  const clock = time == null ? null : duration(time % 0x1000000);
  // ARIB MJD + BCD carries Japan local time, independent of the browser timezone.
  const start =
    clock == null || clock >= 86400000
      ? null
      : (Math.floor(time / 0x1000000) - 40587) * 86400000 + clock - 9 * 3600000;
  const length = duration(event.duration);
  return {
    id: event.eventId,
    title: short ? text(short.eventName) : '',
    description: short ? text(short.text) : '',
    start,
    end: start != null && length != null ? start + length : null,
  };
}

// Keeps SI across decode windows. Only the service selected by the video PMT is exposed.
export class ProgramInformation {
  constructor() {
    this.sections = new Map();
    this.services = new Map();
  }
  resetFragments() {
    this.sections.clear();
  }
  service(id) {
    if (!this.services.has(id))
      this.services.set(id, { serviceId: id, stationName: '', current: null, next: null });
    return this.services.get(id);
  }
  read(bytes, pid) {
    try {
      // The library validates MPEG CRC before parsing descriptors.
      const section = readSection(bytes);
      if (!section?.currentNextIndicator) return;
      if (pid === 0x11 && section.tableId === 'SDT[actual]') {
        for (const service of section.services) {
          const descriptor = service.descriptors.find((d) => d.tag === 'service');
          if (descriptor)
            this.service(service.serviceId).stationName = text(descriptor.serviceName);
        }
      } else if (pid === 0x10 && section.tableId === 'NIT[actual]') {
        // One-seg may omit SDT; the TS name is a useful broadcast-provided fallback.
        for (const stream of section.transportStreams) {
          const info = stream.transportDescriptors.find((d) => d.tag === 'tsInformation');
          if (!info) continue;
          for (const transmission of info.transmissionTypes)
            for (const id of transmission.serviceIdList)
              this.service(id).tsName = text(info.tsName);
        }
      } else if (
        [0x12, 0x26, 0x27].includes(pid) &&
        section.tableId === 'EIT[p/f]' &&
        !section.other &&
        section.sectionNumber <= 1
      ) {
        const service = this.service(section.serviceId);
        service[section.sectionNumber === 0 ? 'current' : 'next'] = eventInfo(section.events[0]);
      }
    } catch {
      // Damaged descriptors must not interrupt audio/video playback.
    }
  }
  append(pid, state, bytes, multiple) {
    state.bytes.push(...bytes);
    while (state.bytes.length >= 3) {
      if (state.bytes[0] === 0xff) {
        state.bytes = [];
        return;
      }
      const length = 3 + ((state.bytes[1] & 15) << 8) + state.bytes[2];
      if (length < 12 || length > 4096) {
        this.sections.delete(pid);
        return;
      }
      if (state.bytes.length < length) return;
      this.read(Uint8Array.from(state.bytes.splice(0, length)), pid);
      if (!multiple) {
        state.bytes = [];
        return;
      }
    }
  }
  push(bytes, serviceId) {
    for (let at = 0; at + 188 <= bytes.length; at += 188) {
      const packet = bytes.subarray(at, at + 188);
      const pid = ((packet[1] & 31) << 8) | packet[2];
      if (!PIDS.has(pid)) continue;
      if (packet[0] !== 0x47 || packet[1] & 128 || packet[3] & 192) {
        this.sections.delete(pid);
        continue;
      }
      const adaptation = !!(packet[3] & 32);
      if (adaptation && packet[4] > 0 && packet[5] & 128) this.sections.delete(pid);
      if (!(packet[3] & 16)) continue;
      let offset = 4 + (adaptation ? 1 + packet[4] : 0);
      if (offset >= 188) {
        this.sections.delete(pid);
        continue;
      }
      const cc = packet[3] & 15;
      let state = this.sections.get(pid);
      if (state?.cc === cc) continue;
      if (state && ((state.cc + 1) & 15) !== cc) {
        this.sections.delete(pid);
        state = null;
      }
      if (packet[1] & 64) {
        const pointer = packet[offset++];
        if (offset + pointer > 188) {
          this.sections.delete(pid);
          continue;
        }
        if (state?.bytes.length)
          this.append(pid, state, packet.subarray(offset, offset + pointer), false);
        offset += pointer;
        state = { cc, bytes: [] };
        this.sections.set(pid, state);
      } else if (!state?.bytes.length) continue;
      state.cc = cc;
      this.append(pid, state, packet.subarray(offset), true);
    }
    if (serviceId == null) return null;
    const service = this.services.get(serviceId);
    return {
      serviceId,
      stationName: service?.stationName || service?.tsName || '',
      current: service?.current ?? null,
      next: service?.next ?? null,
    };
  }
}
