import mpegts from 'mpegts.js';
import type { LiveTransport } from './live-transport.js';

export function attachLivePlayer(
  video: HTMLVideoElement,
  source: LiveTransport,
  report: (message: string) => void,
  recover: (message: string) => void,
) {
  if (!mpegts.getFeatureList().mseLivePlayback)
    throw new Error('Live playback requires Media Source Extensions');
  // Live playback starts only after the startup buffer is ready. Native
  // autoplay would otherwise play early, before begin() chooses its position.
  video.autoplay = false;
  let failed = false;
  class ReceiverLoader extends mpegts.BaseLoader {
    private unsubscribe?: () => void;
    private received = 0;
    constructor() {
      super('rtl-sdr');
    }
    open() {
      this._status = 2;
      this.unsubscribe = source.subscribe((bytes) => {
        if (this._status !== 2 || failed) return;
        const data = bytes.slice().buffer;
        const start = this.received;
        this.received += data.byteLength;
        try {
          this.onDataArrival(data, start, this.received);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      });
    }
    abort() {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this._status = 4;
    }
    destroy() {
      this.abort();
      super.destroy();
    }
  }
  const player = mpegts.createPlayer(
    { type: 'mpegts', isLive: true, url: 'memory://rtl-sdr' },
    {
      customLoader: ReceiverLoader,
      enableWorker: false,
      enableStashBuffer: false,
      lazyLoad: false,
      liveBufferLatencyChasing: false,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15,
      fixAudioTimestampGap: true,
    },
  );
  player.on(mpegts.Events.MEDIA_INFO, (info: unknown) =>
    console.info('Live media info', JSON.stringify(info)),
  );
  let started = false,
    disposed = false;
  const begin = () => {
    if (started || disposed || failed || !video.buffered.length) return;
    const start = video.buffered.start(0),
      end = video.buffered.end(0);
    // Absorb the rolling decoder's cadence without restarting playback every window.
    if (end - start < 4) return;
    started = true;
    // The user may already have pressed play; never replay consumed frames.
    if (video.currentTime < start) video.currentTime = start;
    void player.play()?.catch(() => report('Press play to continue'));
  };
  const fail = (message: string) => {
    if (failed || disposed) return;
    failed = true;
    const error = video.error;
    const reason = error ? `MediaError ${error.code}: ${error.message || message}` : message;
    // Never destroy the demuxer from inside its own data-arrival callback.
    // Stop feeding it immediately, then replace the stream after it unwinds.
    queueMicrotask(() => {
      if (!disposed) recover(reason);
    });
  };
  const mediaError = () => fail('Video playback failed');
  player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { msg?: string }) =>
    fail(`${type}/${detail}: ${info?.msg || detail}`),
  );
  video.addEventListener('error', mediaError);
  video.addEventListener('progress', begin);
  video.addEventListener('canplay', begin);
  player.attachMediaElement(video);
  player.load();
  return () => {
    disposed = true;
    video.removeEventListener('error', mediaError);
    video.removeEventListener('progress', begin);
    video.removeEventListener('canplay', begin);
    player.pause();
    player.unload();
    player.detachMediaElement();
    player.destroy();
  };
}
