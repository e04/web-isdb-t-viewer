import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTransport, TransportJoiner } from '../src/media/live-transport.js';
import { Receiver } from '../src/receiver/receiver-core.js';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const transport = () => {
  const bytes = new Uint8Array(188 * 3);
  for (let i = 0; i < bytes.length; i += 188) bytes[i] = 0x47;
  return bytes;
};

test('stop cancels decoder jobs and releases the USB device', async () => {
  let cancelled = 0,
    aborted = 0;
  const receiver = new Receiver(() => {});
  receiver.device = {
    abort: async () => {
      aborted++;
    },
  };
  receiver.jobs.add({
    cancel() {
      cancelled++;
    },
  });
  receiver.pending = { bytes: new Uint8Array(100) };
  receiver.emit({
    running: true,
    connected: true,
    programInformation: { stationName: 'Previous station' },
  });
  await receiver.stop();
  assert.equal(cancelled, 1);
  assert.equal(aborted, 1);
  assert.equal(receiver.pending, null);
  assert.equal(receiver.jobs.size, 0);
  assert.equal(receiver.state.connected, false);
  assert.equal(receiver.state.programInformation, null);
  assert.equal(receiver.state.busy, false);
});
test('USB short reads stop reception and surface a recoverable error', async () => {
  const receiver = new Receiver(() => {});
  let aborted = false;
  receiver.device = {
    setGain: async () => {},
    setSampleRate: async () => 2048000,
    setCenterFrequency: async (frequency) => frequency,
    resetBuffer: async () => {},
    readSamples: async () => new ArrayBuffer(4),
    abort: async () => {
      aborted = true;
    },
  };
  receiver.emit({ connected: true });
  await receiver.start(27, null);
  assert.match(receiver.state.error, /Short USB read/);
  assert.equal(aborted, true);
  assert.equal(receiver.state.running, false);
});
test('decoder continues after a corrupt capture and publishes live transport', async () => {
  const receiver = new Receiver(() => {});
  receiver.joiner = new TransportJoiner();
  receiver.association = { push: (bytes) => bytes };
  receiver.emit({ stream: new LiveTransport() });
  let delivered;
  receiver.state.stream.subscribe((bytes) => {
    delivered = bytes;
  });
  receiver.pending = { bytes: new Uint8Array(), options: {}, capturedAt: Date.now() };
  let calls = 0;
  receiver.analyze = async () => {
    calls++;
    if (calls === 1) {
      receiver.pending = { bytes: new Uint8Array(), options: {}, capturedAt: Date.now() };
      throw new Error('Corrupt capture');
    }
    return { transport: { bytes: transport() } };
  };
  await receiver.drain(receiver.epoch);
  assert.equal(calls, 2);
  assert.deepEqual(delivered, transport());
  assert.equal(receiver.state.error, '');
  assert.equal(receiver.processing, false);
});
test('log history is bounded', () => {
  const receiver = new Receiver(() => {});
  for (let i = 0; i < 250; i++) receiver.log(String(i));
  assert.equal(receiver.state.logs.length, 200);
  assert.equal(receiver.state.logs[0], '50');
});
test('overlapping stop requests share one device shutdown', async () => {
  const shutdown = deferred();
  let aborted = 0;
  const receiver = new Receiver(() => {});
  receiver.device = {
    abort: () => {
      aborted++;
      return shutdown.promise;
    },
  };
  const first = receiver.stop(),
    second = receiver.stop();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(aborted, 1);
  shutdown.resolve();
  await first;
  assert.equal(receiver.state.busy, false);
});
test('playback failure replaces only the active stream and keeps reception alive', () => {
  const receiver = new Receiver(() => {});
  const stream = new LiveTransport();
  receiver.emit({ running: true, connected: true, stream });
  receiver.recoverPlayback(stream, 'decode failed');
  const replacement = receiver.state.stream;
  assert.notEqual(replacement, stream);
  assert.equal(stream.closed, true);
  assert.equal(receiver.state.running, true);
  assert.equal(receiver.state.connected, true);
  assert.equal(receiver.state.recoveries, 1);
  receiver.recoverPlayback(stream, 'late error from old player');
  assert.equal(receiver.state.stream, replacement);
  assert.equal(receiver.state.recoveries, 1);
});
test('stopped receivers ignore late playback errors', async () => {
  const receiver = new Receiver(() => {});
  const stream = new LiveTransport();
  receiver.emit({ running: true, stream });
  await receiver.stop();
  receiver.recoverPlayback(stream, 'late failure');
  assert.equal(receiver.state.stream, null);
  assert.equal(receiver.state.recoveries, 0);
});
