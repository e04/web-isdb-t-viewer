import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../node_modules/mpegts.js/dist/mpegts.js', import.meta.url);
let code = readFileSync(path, 'utf8');
// mpegts.js 1.8.2 retains an old incomplete AAC frame after a later PES
// completes it. Re-prepending that stale frame corrupts subsequent audio.
const original =
  /([a-z_$]+)\.hasIncompleteData\(\)&&\(this\.aac_last_incomplete_data_=\1\.getIncompleteData\(\)\)/g;
const matches = [...code.matchAll(original)];
if (matches.length === 2) {
  code = code.replace(
    original,
    'this.aac_last_incomplete_data_=$1.hasIncompleteData()?$1.getIncompleteData():null',
  );
  writeFileSync(path, code);
} else if (
  (
    code.match(
      /this\.aac_last_incomplete_data_=[a-z_$]+\.hasIncompleteData\(\)\?[a-z_$]+\.getIncompleteData\(\):null/g,
    ) || []
  ).length !== 2
) {
  throw new Error(
    'mpegts AAC patch no longer matches; review the pinned dependency before upgrading',
  );
}

// Upstream emits an invalid zero-channel ASC for PCE-based AAC broadcasts.
const { aacPceConfig } = await import('../src/media/aac-pce.js');
code = code.replace(
  /Q=function\(e\)\{if\(e.channel_config===0\)\{Object.assign\(this,\([\s\S]*?\)\(e\)\);return;\}var t=null,i=e.audio_object_type/,
  'Q=function(e){var t=null,i=e.audio_object_type',
);
const constructor = 'Q=function(e){var t=null,i=e.audio_object_type';
if (code.includes(constructor)) {
  code = code.replace(
    constructor,
    `Q=function(e){if(e.channel_config===0){Object.assign(this,(${aacPceConfig.toString()})(e));return;}var t=null,i=e.audio_object_type`,
  );
} else if (!code.includes('function aacPceConfig(frame)'))
  throw new Error('mpegts PCE constructor patch no longer matches');
const gate =
  '0==this.audio_init_segment_dispatched_?(this.audio_metadata_={codec:"aac",audio_object_type:_.audio_object_type';
const guard =
  'if(0===_.channel_config&&!this.audio_init_segment_dispatched_&&(_.data[0]>>>5)!==5)continue;';
if (!code.includes(guard)) {
  if (!code.includes(gate)) throw new Error('mpegts PCE initialization gate no longer matches');
  code = code.replace(gate, guard + gate);
}
writeFileSync(path, code);

// Do not submit truncated, unspecified-length video PES to the browser decoder.
const { acceptPESSlice } = await import('../src/media/pes-continuity.js');
const pes = '.handlePESSlice=function(e,t,i,a){';
const pesMarker = '/* receiver PES continuity */';
if (!code.includes(pesMarker)) {
  if (!code.includes(pes)) throw new Error('mpegts PES continuity patch no longer matches');
  code = code.replace(
    pes,
    pes + `${pesMarker}if(!(${acceptPESSlice.toString()}).call(this,e,t,i,a))return;`,
  );
}
writeFileSync(path, code);

// One-seg commonly packs five access units into each PES. Upstream turns the
// whole PES into a single MP4 sample, reducing decoded playback to ~3 fps.
const { splitH264AccessUnits, dispatchH264AccessUnits } =
  await import('../src/media/h264-access-units.js');
const h264 = '.parseH264Payload=function(e,t,i,a,n){';
const marker = '/* one-seg access units */';
// Refresh the embedded helper when this project's implementation changes.
code = code.replace(
  /\/\* one-seg access units \*\/if\(\(function\(\)\{[\s\S]*?\}\)\.call\(this\)\)return;/,
  '',
);
if (!code.includes(marker)) {
  if (!code.includes(h264)) throw new Error('mpegts H264 access-unit patch no longer matches');
  code = code.replace(
    h264,
    h264 +
      `${marker}if((function(){${splitH264AccessUnits.toString()};return (${dispatchH264AccessUnits.toString()}).call(this,e,t,i,a,n)}).call(this))return;`,
  );
}
writeFileSync(path, code);
