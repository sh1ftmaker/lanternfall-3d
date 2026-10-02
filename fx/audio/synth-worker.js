// Worker for the placeholder synthesis (fx/audio/synth.js): returns the channels of one buffer, transferred.
import { synthKey } from './synth.js';
const fake = { createBuffer(ch, n, sr) { const d = Array.from({ length: ch }, () => new Float32Array(n)); return { numberOfChannels: ch, length: n, sampleRate: sr, duration: n / sr, getChannelData: (c) => d[c], d }; } };
self.onmessage = (e) => {
  const { id, key, seed } = e.data, b = synthKey(fake, key, seed);
  self.postMessage({ id, sr: b.sampleRate, data: b.d }, b.d.map((a) => a.buffer));
};
