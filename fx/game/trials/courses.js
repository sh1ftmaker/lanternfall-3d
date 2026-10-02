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
  {
    id: 'swim', name: 'The Spire Swim', short: 'Spire Swim', wick: true, pace: 3, fp: 1,
    blurb: 'From the lake steps out to the Spire\'s island, touch the post on the beach, and swim back. Wick only.',
    where: 'the quay beside the lake steps, south of the Lake Lap post',
    post: [100.4, -8, 0.12, Math.PI],
    cps: [[91, -3, -0.8], [55, 1, -0.8], [18, -4, 0.2, 4, 5], [55, 1, -0.8], [95.5, -2, -0.8]],
    pole: 2,                      // a post stands at this checkpoint during the race: the one to touch
    medals: { gold: 50, silver: 70 },
    stray: 130,
  },
  {
    id: 'roof', name: 'The Meridian Rooftops', short: 'Rooftops', wick: true, pace: 5, fp: 1,
    blurb: 'From the station forecourt, a long jump, a triple jump to a roof, then ledge to ledge up to the high deck by the monorail. Wick only.',
    where: 'the forecourt south of the Meridian Loop station',
    post: [28.3, 98.8, 0.12, Math.PI / 2],
    // landings of a route proven in tools/game/trials.test.mjs (jump kinds and run-ups in tools/game/trials-roof.json); rings pass within 4.5 m and 2.4 m of height
    cps: [[48.2, 126.9, 5.2], [59.1, 123.3, 10.4], [54.5, 106.5, 10], [56.3, 111.1, 11]].map(([x, y, z]) => [x, y, z, 4.5, 2.4]),
    medals: { gold: 40, silver: 65 },
    stray: 80,
  },
];
