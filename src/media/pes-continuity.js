// Called before mpegts.js assembles a PES. A video PES may have unspecified
// length, so the upstream length check alone cannot detect missing TS packets.
// Self-contained for embedding in the pinned demuxer build.
export function acceptPESSlice(buffer, offset, length, misc) {
  const states = (this.receiver_pes_continuity_ ??= new Map());
  const data = new Uint8Array(buffer, offset, length);
  const previous = states.get(misc.pid);
  const cc = misc.continuity_conunter;
  if (
    previous &&
    cc === previous.cc &&
    previous.start === misc.payload_unit_start_indicator &&
    data.length === previous.data.length &&
    data.every((value, index) => value === previous.data[index])
  )
    return false;
  states.set(misc.pid, { cc, start: misc.payload_unit_start_indicator, data: data.slice() });
  if (previous && cc !== ((previous.cc + 1) & 15)) {
    delete this.pes_slice_queues_[misc.pid];
    if (misc.stream_type === 0x0f || misc.stream_type === 0x11) {
      this.aac_last_incomplete_data_ = null;
      this.audio_last_sample_pts_ = undefined;
    }
  }
  // Upstream ignores continuations until a new payload-unit start arrives.
  return true;
}
