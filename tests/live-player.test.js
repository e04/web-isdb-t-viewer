import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { LiveTransport } from '../src/media/live-transport.js';

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/media/live-player.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText;
function fixture() {
  const handlers = {},
    received = [],
    failures = [];
  let loader,
    destroyed = false,
    throwOnData = false,
    plays = 0;
  const player = {
    on(event, callback) {
      handlers[event] = callback;
    },
    attachMediaElement() {},
    load() {
      loader.open();
    },
    play() {
      plays++;
      return Promise.resolve();
    },
    pause() {},
    unload() {
      loader.abort();
    },
    detachMediaElement() {},
    destroy() {
      destroyed = true;
      loader.destroy();
    },
  };
  const mpegts = {
    getFeatureList: () => ({ mseLivePlayback: true }),
    BaseLoader: class {
      destroy() {}
    },
    Events: { ERROR: 'error', MEDIA_INFO: 'info' },
    createPlayer(_source, config) {
      loader = new config.customLoader();
      loader.onDataArrival = (data) => {
        if (throwOnData) throw new Error('damaged PES');
        received.push(data);
      };
      return player;
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: () => mpegts, console, queueMicrotask, Error });
  const video = new EventTarget();
  video.buffered = { length: 0 };
  video.error = null;
  video.currentTime = 0;
  video.autoplay = true;
  const source = new LiveTransport();
  const dispose = exports.attachLivePlayer(
    video,
    source,
    () => {},
    (reason) => failures.push(reason),
  );
  return {
    video,
    source,
    failures,
    received,
    handlers,
    dispose,
    get plays() {
      return plays;
    },
    get destroyed() {
      return destroyed;
    },
    corrupt() {
      throwOnData = true;
    },
  };
}
test('live startup waits for four contiguous seconds and starts once', () => {
  const f = fixture();
  assert.equal(f.video.autoplay, false);
  f.video.buffered = { length: 1, start: () => 1, end: () => 3 };
  f.video.dispatchEvent(new Event('canplay'));
  assert.equal(f.plays, 0);
  f.video.buffered = { length: 1, start: () => 1, end: () => 6 };
  f.video.dispatchEvent(new Event('progress'));
  assert.equal(f.plays, 1);
  assert.equal(f.video.currentTime, 1);
  f.video.currentTime = 2;
  f.video.dispatchEvent(new Event('canplay'));
  f.video.dispatchEvent(new Event('progress'));
  assert.equal(f.plays, 1);
  assert.equal(f.video.currentTime, 2);
  f.dispose();
});
test('startup never rewinds playback already started by the user', () => {
  const f = fixture();
  f.video.currentTime = 2;
  f.video.buffered = { length: 1, start: () => 1, end: () => 6 };
  f.video.dispatchEvent(new Event('progress'));
  assert.equal(f.video.currentTime, 2);
  assert.equal(f.plays, 1);
  f.dispose();
});
test('gaps do not count toward the startup buffer', () => {
  const f = fixture();
  f.video.buffered = { length: 2, start: (i) => (i ? 10 : 1), end: (i) => (i ? 12 : 2) };
  f.video.dispatchEvent(new Event('progress'));
  assert.equal(f.plays, 0);
  f.dispose();
});
test('fatal MSE error stops data delivery immediately and recovers once after callback unwinds', async () => {
  const f = fixture();
  f.source.write(new Uint8Array([1]));
  f.handlers.error('MediaError', 'MSEError', { msg: 'append failed' });
  f.source.write(new Uint8Array([2]));
  f.handlers.error('MediaError', 'MSEError', { msg: 'repeated' });
  assert.equal(f.received.length, 1);
  assert.equal(f.failures.length, 0);
  await Promise.resolve();
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0], /append failed/);
  f.dispose();
  assert.equal(f.destroyed, true);
});
test('first media decode error is preserved instead of repeated append errors', async () => {
  const f = fixture();
  f.video.error = { code: 3, message: 'decoder failure' };
  f.video.dispatchEvent(new Event('error'));
  f.handlers.error('MediaError', 'MSEError', { msg: 'append failed' });
  await Promise.resolve();
  assert.deepEqual(f.failures, ['MediaError 3: decoder failure']);
  f.dispose();
});
test('cleanup cancels deferred recovery from an obsolete player', async () => {
  const f = fixture();
  f.handlers.error('MediaError', 'MSEError');
  f.dispose();
  await Promise.resolve();
  assert.equal(f.failures.length, 0);
  f.video.dispatchEvent(new Event('error'));
  await Promise.resolve();
  assert.equal(f.failures.length, 0);
});
test('synchronous demux exceptions use the same recovery path', async () => {
  const f = fixture();
  f.corrupt();
  assert.doesNotThrow(() => f.source.write(new Uint8Array([1])));
  await Promise.resolve();
  assert.deepEqual(f.failures, ['damaged PES']);
  f.dispose();
});
