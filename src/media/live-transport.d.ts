export class LiveTransport {
  closed: boolean;
  write(bytes: Uint8Array): void;
  subscribe(listener: (bytes: Uint8Array) => void): () => void;
  close(): void;
}
export class TransportJoiner {
  push(bytes: Uint8Array): { bytes: Uint8Array; overlap: number; discontinuity: boolean };
}
