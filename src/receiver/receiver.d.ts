import type { LiveTransport } from '../media/live-transport.js';
export interface ReceptionResult {
  points: Float32Array;
  spectrum: { x: Float32Array; y: Float32Array };
  metrics: {
    locked: boolean;
    clearQpsk: boolean;
    cpCorrelation: number;
    pilotCoherence: number;
    evmPercent: number | null;
    merDb: number | null;
    totalCfoHz: number;
    clippedPercent: number;
    symbols: number;
    guardRatio: string;
  };
  transport?: {
    bytes: Uint8Array;
    validPackets?: number;
    failedPackets?: number;
    correctedBytes?: number;
    tmccFrames: number;
    error?: string;
    parameters?: { rateIndex: number; interleave: number };
  };
}
export interface ProgramEvent {
  id: number;
  title: string;
  description: string;
  start: number | null;
  end: number | null;
}
export interface ProgramInformation {
  serviceId: number;
  stationName: string;
  current: ProgramEvent | null;
  next: ProgramEvent | null;
}
export interface ReceiverState {
  programInformation: ProgramInformation | null;
  status: string;
  connected: boolean;
  busy: boolean;
  running: boolean;
  error: string;
  logs: string[];
  result: ReceptionResult | null;
  stream: LiveTransport | null;
  dropped: number;
  latency: number;
  progress: number;
  recoveries: number;
  decodeMs: number;
}
export const initialState: ReceiverState;
export class Receiver {
  constructor(update: (state: ReceiverState) => void);
  connect(gain: number | null): Promise<void>;
  stop(): Promise<void>;
  start(channel: number, gain: number | null): Promise<void>;
  emit(patch: Partial<ReceiverState>): void;
  logError(message: string): void;
  recoverPlayback(stream: LiveTransport, message: string): void;
}
