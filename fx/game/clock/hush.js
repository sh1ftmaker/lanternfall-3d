// The silent four minutes (23:00-23:04): music and murmur duck to almost nothing, guests by the lake face the Spire.
export function createHush(game) {
  const h = { on: false, k: 0, start() { h.on = true; }, stop() { h.on = false; }, frame() {} };
  return h;
}
