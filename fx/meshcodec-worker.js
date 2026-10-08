// Loader worker (app.js): gunzip + decode one part of the park off the main thread; the arrays come back transferred.
// in: { id, buf: Uint8Array (as downloaded, gzip), meshes: manifest part meshes }  out: { id, meshes: [...] } | { id, error }
import { decodePart, gunzip } from './meshcodec.js';
self.onmessage = async (e) => {
  const { id, buf, meshes } = e.data;
  try {
    const u8 = await gunzip(buf), out = decodePart(u8, meshes), tr = [];
    for (const d of out) for (const k of ['pos', 'col', 'aux', 'idx', 'lay', 'mat']) if (d[k]) tr.push(d[k].buffer);
    self.postMessage({ id, meshes: out }, tr);
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
