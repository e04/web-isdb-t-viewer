type RtlSdrOpenOptions = {
  ppm: number;
  gain?: number | null;
};

type RtlSdrDevice = {
  open: (options: RtlSdrOpenOptions) => Promise<void>;
  setGain: (gain: number | null) => Promise<void>;
  abort: () => Promise<void>;
  setSampleRate: (sampleRate: number) => Promise<number>;
  setCenterFrequency: (centerFrequency: number) => Promise<number>;
  resetBuffer: () => Promise<void>;
  readSamples: (length: number) => Promise<ArrayBuffer>;
  close: () => Promise<void>;
};

type RtlSdrApi = {
  requestDevice: () => Promise<RtlSdrDevice>;
  getDevices: () => Promise<RtlSdrDevice[]>;
};

declare const RtlSdr: RtlSdrApi;

export default RtlSdr;
