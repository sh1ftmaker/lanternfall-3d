// The three courses. Blender frame (x east, y north, z up), metres. A course is a start post, checkpoints passed in order
// (the last one is the finish) and the medal times (seconds) for a clean Wick run; first-person times are scaled by `fp`.
// cp: [x, y, z, radius?, half-height?]  default radius 5 m, 7 m up or down.
export const COURSES = [
  {
    id: 'lake', name: 'The Lake Lap', short: 'Lake Lap', wick: false, pace: 6, fp: 2,
    blurb: 'Once round Stillwater on the ring promenade, about 535 m.',
    where: 'East Gate end of the avenue, at the lake steps',
    post: [103.6, 9, 0.12, Math.PI],
    // 14 points about 38 m apart round the lake (kept inland of the Brinewatch bay), anticlockwise from the steps; the 14th is the finish at the start line
    cps: [[85, 35.9], [52.9, 53.5], [16.6, 62.4], [-20.4, 59.9], [-56.3, 51.9], [-87.1, 31.6], [-98.2, -3.9], [-86.9, -38.9], [-52.6, -53.5], [-16.2, -59.8], [20.9, -64.3], [56, -66], [88, -42], [100.7, 3.3]].map(([x, y]) => [x, y, 0.12]),
    medals: { gold: 70, silver: 90 },
    stray: 110,
  },
];
