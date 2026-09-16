// A PES may carry several H.264 pictures. MP4 requires one access unit per
// sample; passing the entire PES to a decoder displays only one of them.
export function splitH264AccessUnits(data) {
  const boundaries = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const prefix = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (!prefix) continue;
    if ((data[i + prefix] & 31) === 9) boundaries.push(i);
    i += prefix - 1;
  }
  if (boundaries.length < 2) return [data];
  // Preserve any headers preceding the first AUD.
  boundaries[0] = 0;
  return boundaries.map((start, index) =>
    data.subarray(start, boundaries[index + 1] ?? data.length),
  );
}

export function dispatchH264AccessUnits(data, pts, dts, position, randomAccess) {
  const units = splitH264AccessUnits(data);
  if (units.length === 1) return false;
  let delta = 0;
  for (let index = 0; index < units.length; index++) {
    this.parseH264Payload(
      units[index],
      pts + delta,
      dts + delta,
      position,
      index === 0 ? randomAccess : 0,
    );
    // The first access unit supplies SPS timing before subsequent pictures.
    const rate = this.video_metadata_.details?.frame_rate;
    if (!rate?.fps_num || !rate?.fps_den) {
      // Joining a live stream often starts between keyframes. The upstream
      // parser discards pictures until SPS/IDR arrive; this is not a failure.
      if (!this.video_init_segment_dispatched_) return true;
      throw new Error('H.264 access units require SPS frame timing');
    }
    delta += (90000 * rate.fps_den) / rate.fps_num;
  }
  return true;
}
