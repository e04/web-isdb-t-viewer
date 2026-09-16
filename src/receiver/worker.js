import { analyzeIQ } from './dsp.js';
import { decodeTransport } from './transport.js';
self.onmessage = ({ data }) => {
  try {
    const progress = (stage) => self.postMessage({ stage });
    const result = analyzeIQ(new Uint8Array(data.buffer), data.options, progress);
    if (data.options?.decode)
      result.transport = decodeTransport(result.carriers, result.metrics, progress);
    delete result.carriers;
    const transfers = [
      result.spectrum.x.buffer,
      result.spectrum.y.buffer,
      result.correlation.buffer,
      result.raw.buffer,
      result.points.buffer,
    ];
    if (result.transport) transfers.push(result.transport.bytes.buffer);
    self.postMessage({ result }, transfers);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
