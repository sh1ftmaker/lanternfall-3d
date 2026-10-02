// The three courses. Blender frame (x east, y north, z up), metres. A course is a start post, checkpoints passed in order
// (the last one is the finish) and the medal times (seconds) for a clean Wick run; first-person times are scaled by `fp`.
// cp: [x, y, z, radius?, half-height?]  default radius 5 m, 7 m up or down.
export const COURSES = [
  {
    id: 'lake', name: 'The Lake Lap', short: 'Lake Lap', wick: false, pace: 6, fp: 1.5,
    blurb: 'Once round Stillwater on the ring promenade, about 535 m.',
    where: 'East Gate end of the avenue, at the lake steps',
    post: [103.6, 9, 0.12, Math.PI],
    // 17 points about 20-40 m apart, each 4 m inland of the water's edge on the promenade (the lake is not a circle: the south shore is 60 m out, the
    // east 98 m, so a ring of equal radius ran through the water); the 17th is the finish at the start line. Checked against the walk grid: no
    // leg crosses water, and the only bumps are single bench tops
    cps: [[82.9, 40.4], [45.6, 58.4], [13.4, 63.1], [-15.2, 61.1], [-46.6, 55.5], [-84, 37.4], [-100.8, 7], [-95.6, -31], [-67, -52.3], [-35.2, -56.4], [-8.8, -62.9], [18.6, -64.9], [50.1, -55.7], [74.9, -33.4], [92, -28], [107, -17], [100.7, 3.3]].map(([x, y]) => [x, y, 0.12]),
    medals: { gold: 66, silver: 84 },
    stray: 110,
  },
  {
    id: 'swim', name: 'The Spire Swim', short: 'Spire Swim', wick: true, pace: 3, fp: 1,
    blurb: 'From the lake steps out to the Spire\'s island, touch the post on the beach, and swim back.',
    where: 'the quay beside the lake steps, south of the Lake Lap post',
    post: [100.4, -8, 0.12, Math.PI],
    cps: [[91, -3, -0.8], [55, 1, -0.8], [18, -4, 0.2, 4, 5], [55, 1, -0.8], [95.5, -2, -0.8]],
    pole: 2,                      // a post stands at this checkpoint during the race: the one to touch
    medals: { gold: 45, silver: 65 },
    stray: 130,
  },
  {
    id: 'roof', name: 'The Meridian Rooftops', short: 'Rooftops', wick: true, pace: 5, fp: 1,
    blurb: 'From the station forecourt, a long jump, a triple jump to a roof, then ledge to ledge up to the high deck by the monorail.',
    where: 'the forecourt south of the Meridian Loop station',
    post: [28.3, 98.8, 0.12, Math.PI / 2],
    // landings of a route proven in tools/game/trials.test.mjs (jump kinds and run-ups in tools/game/trials-roof.json); rings pass within 4.5 m and 2.4 m of height
    cps: [[48.2, 126.9, 5.2], [59.1, 123.3, 10.4], [54.5, 106.5, 10], [56.3, 111.1, 11]].map(([x, y, z]) => [x, y, z, 4.5, 2.4]),
    medals: { gold: 24, silver: 45 },
    stray: 80,
  },
];
