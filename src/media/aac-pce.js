// AAC channel_configuration=0 carries its layout in a Program Config Element.
// Resolve mono/stereo layout for MSE; the original in-band PCE remains in AAC.
// Kept self-contained because the pinned demuxer patch embeds this function.
export function aacPceConfig(frame) {
  const data = frame.data;
  let position = 0;
  const read = (count) => {
    if (position + count > data.length * 8) throw new Error('Truncated AAC program configuration');
    let value = 0;
    while (count--) {
      value = (value << 1) | ((data[position >>> 3] >>> (7 - (position & 7))) & 1);
      position++;
    }
    return value;
  };
  if (read(3) !== 5) throw new Error('Waiting for AAC program configuration');
  read(4);
  const objectType = read(2) + 1,
    frequency = read(4);
  const front = read(4),
    side = read(4),
    back = read(4),
    lfe = read(2),
    associated = read(3),
    coupling = read(4);
  if (read(1)) read(4);
  if (read(1)) read(4);
  if (read(1)) read(3);
  let channels = lfe;
  for (let i = 0; i < front + side + back; i++) {
    channels += read(1) ? 2 : 1;
    read(4);
  }
  for (let i = 0; i < lfe + associated; i++) read(4);
  for (let i = 0; i < coupling; i++) read(5);
  position = Math.ceil(position / 8) * 8;
  const commentLength = read(8),
    comments = [];
  for (let i = 0; i < commentLength; i++) comments.push(read(8));
  if (!channels || frequency > 12 || objectType !== 2)
    throw new Error('Unsupported AAC program configuration');
  // Chromium rejects channel_configuration=0 in MP4 even with an embedded PCE.
  // Declare the observed channel count; the unchanged first AAC access unit still
  // carries its PCE (including dual-mono element mapping) for the audio decoder.
  if (channels > 2) throw new Error('Unsupported one-seg AAC channel layout');
  const config = [(objectType << 3) | (frequency >>> 1), ((frequency & 1) << 7) | (channels << 3)];
  const frequencies = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  return {
    config,
    channel_count: channels,
    sampling_rate: frequencies[frequency],
    codec_mimetype: 'mp4a.40.2',
    original_codec_mimetype: 'mp4a.40.2',
  };
}
