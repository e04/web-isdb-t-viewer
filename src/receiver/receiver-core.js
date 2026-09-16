import { ProgramInformation } from './program-information.js';
import { ProgramAssociation } from '../media/program-association.js';
import { LiveTransport, TransportJoiner } from '../media/live-transport.js';
import { channels } from './channels.js';
import RtlSdr from '../radio/rtlsdr.js';
import { SAMPLE_RATE, TUNER_OFFSET } from './dsp.js';

export const initialState = {
  status: 'Disconnected',
  connected: false,
  busy: false,
  running: false,
  error: '',
  logs: [],
  result: null,
  stream: null,
  programInformation: null,
  dropped: 0,
  latency: 0,
  progress: 0,
  recoveries: 0,
  decodeMs: 0,
};
export class Receiver {
  constructor(update) {
    this.update = update;
    this.state = { ...initialState };
    this.jobs = new Set();
    this.programInformation = new ProgramInformation();
    this.epoch = 0;
  }
  emit(patch) {
    const previousError = this.state.error;
    this.state = { ...this.state, ...patch };
    if (patch.error && patch.error !== previousError) this.logError(patch.error);
    else this.update(this.state);
  }
  log(message) {
    this.emit({ logs: [...this.state.logs.slice(-199), message] });
  }
  logError(message) {
    console.error(message);
    this.log(`[ERROR] ${message}`);
  }
  recoverPlayback(stream, message) {
    if (!this.state.running || this.state.stream !== stream || stream.closed) return;
    stream.close();
    this.logError(message);
    this.log('Reinitializing playback; waiting for the next keyframe');
    this.emit({ stream: new LiveTransport(), recoveries: this.state.recoveries + 1 });
  }
  async connect(gain) {
    if (this.state.busy || this.device) return;
    const epoch = ++this.epoch;
    this.emit({ busy: true, error: '', status: 'Connecting' });
    let device;
    try {
      const permitted = await RtlSdr.getDevices();
      device = permitted.length === 1 ? permitted[0] : await RtlSdr.requestDevice();
      if (epoch !== this.epoch) return;
      await device.open({ ppm: 0, gain });
      if (epoch !== this.epoch) {
        await device.abort();
        return;
      }
      this.device = device;
      this.usb = typeof navigator !== 'undefined' ? navigator.usb : null;
      this.onDisconnect = (event) => {
        if (event.device !== device._usbDevice?._device) return;
        this.emit({ error: 'RTL-SDR disconnected. Reconnect the receiver.' });
        void this.stop();
      };
      this.usb?.addEventListener('disconnect', this.onDisconnect);
      this.emit({ connected: true, status: 'Ready' });
    } catch (error) {
      await device?.abort().catch(() => {});
      if (epoch === this.epoch)
        this.emit({
          error: error.name === 'NotFoundError' ? '' : error.message,
          status: 'Disconnected',
        });
    } finally {
      if (epoch === this.epoch) this.emit({ busy: false });
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    ++this.epoch;
    this.pending = null;
    this.state.stream?.close();
    for (const job of this.jobs) job.cancel();
    this.jobs.clear();
    const device = this.device;
    this.device = null;
    if (this.onDisconnect) this.usb?.removeEventListener('disconnect', this.onDisconnect);
    this.onDisconnect = null;
    this.emit({
      running: false,
      connected: false,
      busy: true,
      status: 'Stopping',
      progress: 0,
      stream: null,
      programInformation: null,
    });
    this.stopping = Promise.resolve()
      .then(() => device?.abort())
      .catch((error) => this.log(error.message))
      .finally(() => {
        this.stopping = null;
        this.emit({ busy: false, status: 'Disconnected' });
      });
    return this.stopping;
  }
  analyze(bytes, options, monitor = false) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const finish = () => {
        clearTimeout(timer);
        worker.terminate();
        this.jobs.delete(job);
      };
      const job = {
        cancel: () => {
          finish();
          reject(new Error('Cancelled'));
        },
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error('Decoder timed out'));
      }, 90000);
      this.jobs.add(job);
      worker.onmessage = ({ data }) => {
        if (data.stage) {
          if (!monitor) this.emit({ status: data.stage });
          return;
        }
        finish();
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message || 'Decoder worker failed'));
      };
      worker.postMessage({ buffer: bytes.buffer, options }, [bytes.buffer]);
    });
  }
  async start(channel, gain) {
    if (!this.device || this.state.busy || this.state.running) return;
    const station = channels.find((station) => station.channel === channel);
    if (!station) {
      this.emit({ error: 'Choose a physical channel from 13 to 52' });
      return;
    }
    const epoch = ++this.epoch,
      device = this.device;
    this.joiner = new TransportJoiner();
    this.association = new ProgramAssociation();
    this.programInformation = new ProgramInformation();
    const stream = new LiveTransport();
    this.emit({
      stream,
      programInformation: null,
      running: true,
      busy: true,
      error: '',
      result: null,
      dropped: 0,
      latency: 0,
      recoveries: 0,
      decodeMs: 0,
      status: 'Tuning',
    });
    this.processing = false;
    let monitoring = false;
    try {
      await device.setGain(gain);
      const sampleRate = await device.setSampleRate(SAMPLE_RATE);
      const tuned = await device.setCenterFrequency(station.center + TUNER_OFFSET);
      await device.resetBuffer();
      if (epoch !== this.epoch) return;
      const options = { sampleRate, offset: tuned - station.center, decode: true };
      this.emit({ busy: false, status: 'Receiving' });
      const block = 32768,
        count = 375,
        stride = 187;
      let bytes = new Uint8Array(count * block * 2),
        index = 0,
        capturedAt = Date.now();
      // Keep USB reads outstanding even while workers decode the previous capture.
      const read = () =>
        device.readSamples(block).then(
          (data) => ({ data }),
          (error) => ({ error }),
        );
      const reads = Array.from({ length: 4 }, read);
      while (epoch === this.epoch) {
        let timer;
        const packet = await Promise.race([
          reads.shift(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('USB read timed out. Reconnect the receiver.')),
              5000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        if (epoch !== this.epoch) break;
        if (packet.error) throw packet.error;
        if (packet.data.byteLength !== block * 2)
          throw new Error('Short USB read. Reconnect the receiver.');
        reads.push(read());
        bytes.set(new Uint8Array(packet.data), index++ * block * 2);
        if (index % 16 === 0) this.emit({ progress: (index / count) * 100 });
        if (index % 64 === 0 && !monitoring) {
          monitoring = true;
          const sample = bytes.slice((index - 32) * block * 2, index * block * 2);
          void this.analyze(sample, { ...options, decode: false }, true)
            .then((result) => {
              if (epoch === this.epoch)
                this.emit({ result: { ...result, transport: this.state.result?.transport } });
            })
            .catch((error) => {
              if (epoch === this.epoch) this.log(error.message);
            })
            .finally(() => {
              monitoring = false;
            });
        }
        if (index === count) {
          if (this.pending) this.emit({ dropped: this.state.dropped + 1 });
          const overlap = bytes.slice(stride * block * 2);
          this.pending = { bytes, options, capturedAt };
          void this.drain(epoch);
          bytes = new Uint8Array(count * block * 2);
          bytes.set(overlap);
          index = count - stride;
          capturedAt += ((stride * block) / sampleRate) * 1000;
        }
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.emit({ error: error.message });
        await this.stop();
      }
    }
  }
  async drain(epoch) {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pending && epoch === this.epoch) {
        const capture = this.pending;
        this.pending = null;
        try {
          const decodeStarted = performance.now();
          const result = await this.analyze(capture.bytes, capture.options);
          if (epoch !== this.epoch) return;
          this.emit({ result, decodeMs: performance.now() - decodeStarted });
          if (!result.transport.bytes.length) {
            this.emit({ status: 'Searching', error: result.transport.error });
            continue;
          }
          const joined = this.joiner.push(result.transport.bytes);
          if (joined.discontinuity) {
            this.programInformation.resetFragments();
            this.log('Transport discontinuity: reacquiring playback');
            this.state.stream.close();
            this.emit({ stream: new LiveTransport() });
          }
          const playable = this.association.push(joined.bytes);
          this.emit({
            programInformation: this.programInformation.push(
              joined.bytes,
              this.association.program?.number,
            ),
          });
          this.state.stream.write(playable);
          if (!playable.length) this.log('Waiting for a one-seg PMT');
          this.emit({
            error: '',
            status: 'Receiving',
            latency: (Date.now() - capture.capturedAt) / 1000,
          });
        } catch (error) {
          if (epoch === this.epoch) this.emit({ error: error.message, status: 'Searching' });
        }
      }
    } finally {
      if (epoch === this.epoch) this.processing = false;
    }
  }
}
