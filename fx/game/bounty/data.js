// fx/game/bounty/data.js: where things are, and the words. Blender frame (x east, y north, z up), metres.
// A spot is { land, x, y } in the land's own frame (+y outward, -y lakeward; see world()) or { wx, wy } in the world;
// `z` is given only where the walk grid is wrong (roofs, the station deck, the Spire island); otherwise the grid height is used.

// land-local -> world: the land's centre, its outward direction (cos phi, sin phi) and the tangent (sin phi, -cos phi)
export function world(lands, s) {
  if (s.wx !== undefined) return [s.wx, s.wy];
  const l = lands[s.land], c = Math.cos(l.phi), n = Math.sin(l.phi);
  return [l.center[0] + s.x * n + s.y * c, l.center[1] - s.x * c + s.y * n];
}

export const LAND_ORDER = ['brinewatch', 'wanderers', 'meridian', 'frostmere', 'guildhollow', 'rosewick', 'lantern-row', 'spire'];
export const LAND_NAME = { brinewatch: 'Brinewatch Wharf', wanderers: "The Wanderers' Hall", meridian: 'Meridian Rail', frostmere: 'Frostmere Keep', guildhollow: 'Guildhollow', rosewick: 'Rosewick Gardens', 'lantern-row': 'Lantern Row', spire: 'The Spire' };

export const SPOTS = {
  board: { land: 'brinewatch', x: 2, y: 4.2 },            // in front of the Bounty Board (the board stands at local (2, 9))
  hut: { land: 'brinewatch', x: 11.2, y: 1.7 },            // the reward counter hut, local (14, 3), counter faces the lake side
  bell: { wx: -131.0, wy: 8.9, z: 0.5 },                   // the strength bell's platform, Guild Fair Midway
  bellTop: { wx: -131.0, wy: 10.1 },                       // foot of the leaning tower
  signing: { land: 'wanderers', x: -26.5, y: 7 },          // Signing Tables, west nave
  tavern: { land: 'brinewatch', x: -19, y: -38 },          // the bar in the Brine & Barrel
  logTable: { land: 'brinewatch', x: -24, y: -45 },        // a barrel table on the tavern deck
  dock: { land: 'brinewatch', x: 13.6, y: -92 },           // the cruise jetty
  gatekeeper: { land: 'frostmere', x: 0, y: -12 },         // Snowbound Gate
  shrine: { land: 'lantern-row', x: 0, y: 24 },            // the Shrine of Wishes, in front of the hall
  balloon: { land: 'lantern-row', x: -6, y: 10 },    // above the lantern lane between the torii and the market
  child: { land: 'rosewick', x: -7, y: 17 },               // foot of the Pavilion of Wings
  bow: { land: 'rosewick', x: 30, y: 24 },                 // Blossom Lane
  busker: { land: 'rosewick', x: -14, y: 10 },             // Moonlit Promenade
  desk: { land: 'wanderers', x: 33, y: -12 },              // the Lost & Found counter (front, lake side), local (33, -8) is the kiosk
  shelf: { land: 'wanderers', x: 33, y: -6.2, z: 3.1 },    // the plank we add on the back wall
  boatsAt: { land: 'brinewatch', x: -2, y: -84 },          // centre of the boats we float off the wharf
};

// Eight stamp posts. `wick`: needs the lamplighter's moves (roof, stall roof) or a swim.
export const STAMPS = {
  brinewatch: { wx: 109.5, wy: -67.7, z: 3.02, wick: true, clue: "Climb aboard the boat on the Boatwright's slipway, at the west end of the wharf." },
  guildhollow: { wx: -120, wy: -5, z: 3.27, wick: true, clue: 'Up on a striped stall roof on the Guild Fair Midway.' },
  frostmere: { wx: -149, wy: 101.3, z: 2.98, wick: true, clue: 'On the snowy stall roofs of the Frost Fair.' },
  spire: { wx: 8.5, wy: 0, z: 0.6, wick: true, clue: 'Swim out to the Spire island, as the lamplighter.' },
  'lantern-row': { wx: 24.8, wy: -177.2, clue: 'Where the ghost stories are told, on the stage at the back of the Row.' },
  rosewick: { land: 'rosewick', x: -30, y: 25, clue: 'At the east exit of the Rose Maze.' },
  meridian: { wx: 46.8, wy: 118.2, z: 10.0, clue: 'Up the stairs, on the monorail platform.' },
  wanderers: { land: 'wanderers', x: 26.5, y: 10, clue: "In the Hall's east nave, past the Paper Doors." },
};

// The pool: three are drawn each calendar day. `at` names a SPOT (or other places) used by the job's steps.
export const JOBS = [
  { id: 'balloon', title: "Pip's red balloon", short: 'Fetch the red balloon', text: "A child by the Pavilion of Wings lost a red balloon. It is snagged high above the shrine lane in Lantern Row. Bring it back." },
  { id: 'letter', title: 'A letter for the Signing Tables', short: 'Carry the letter to the Signing Tables', text: "Take this sealed letter to the Signing Tables in the Wanderers' Hall. Leave it on the tray." },
  { id: 'bell', title: 'Test your mettle', short: 'Ring the strength bell', text: 'The Guildhollow barker wants to hear the strength bell, at least once, tonight. Ring it.' },
  { id: 'boats', title: 'Count the boats', short: 'Count the boats off the wharf', text: 'How many boats are moored off Brinewatch Wharf tonight? Go and count, then give the number here.' },
  { id: 'bow', title: "The busker's bow", short: "Find the busker's bow", text: "The busker on the Moonlit Promenade in Rosewick lost her bow somewhere along Blossom Lane. Bring it back to her." },
  { id: 'drink', title: 'Hot cider, quick', short: 'Cider to the Frostmere gatekeeper', text: 'Take a hot cider from the Brine & Barrel to the gatekeeper at Snowbound Gate in Frostmere before it goes cold. You have three minutes.' },
  { id: 'candle', title: 'A candle for a wish', short: 'Light a candle at the Shrine of Wishes', text: 'Someone left a wish with no light under it. Light a candle at the Shrine of Wishes in Lantern Row.' },
  { id: 'log', title: "The ferry master's log", short: "Log to the cruise dock", text: "The ferry master left his log on a table in the Brine & Barrel. Take it to the cruise dock before the last boat." },
];

export const DRINK_SECONDS = 180;

// Eight lost things. `build` names the model in art.js; `clue` is the one-liner in the journal while it is missing.
export const LOST = [
  { id: 'mitten', name: 'red mitten', where: 'Frostmere', spot: { land: 'frostmere', x: -18, y: -37 }, clue: 'A child lost a mitten near the skating rink in Frostmere.', back: 'Back with a very cold child.' },
  { id: 'crown', name: 'paper crown', where: 'Rosewick', spot: { land: 'rosewick', x: -48, y: 14.2 }, clue: 'A paper crown, at the heart of the Rose Maze.', back: 'Made for a very serious king.' },
  { id: 'sword', name: 'toy sword', where: 'Guildhollow', spot: { land: 'guildhollow', x: 3, y: 28 }, clue: "A toy sword, dropped in the castle courtyard in Guildhollow.", back: 'A squire is missing it badly.' },
  { id: 'ticket', name: 'monorail ticket', where: 'Meridian', spot: { land: 'meridian', x: 0, y: -20 }, clue: 'A monorail ticket, blown about the Meridian Loop station.', back: 'Punched once, never used.' },
  { id: 'cap', name: "sailor's cap", where: 'Brinewatch', spot: { land: 'brinewatch', x: -5, y: -66 }, clue: "A sailor's cap, on the quay by the Harbour Square.", back: 'It smells of tar and rope.' },
  { id: 'tag', name: 'wish tag', where: 'Lantern Row', spot: { land: 'lantern-row', x: 8, y: 18 }, clue: 'A wish tag, off its string, near the shrine steps in Lantern Row.', back: 'Someone wished for a quiet night.' },
  { id: 'net', name: 'butterfly net', where: 'Rosewick', spot: { land: 'rosewick', x: 7, y: 17 }, clue: 'A butterfly net, left by the carousel in Rosewick.', back: 'No butterflies inside. Yet.' },
  { id: 'postcard', name: 'signed postcard', where: 'East Gate', spot: { wx: 284, wy: 6 }, clue: 'A signed postcard, near the East Gate.', back: 'Signed by someone important. Probably.' },
];

// Lantern colours for Wick: linear-ish rgb the character shader multiplies (the default is 1.0, 0.62, 0.28).
export const COLORS = [
  { id: 'amber', name: 'Amber', rgb: [1.0, 0.62, 0.28], css: '#ffb547', free: true },
  { id: 'moss', name: 'Marsh green', rgb: [0.42, 1.0, 0.5], css: '#6ee08a', need: 'Three jobs done, or a full passport' },
  { id: 'violet', name: 'Wanderer violet', rgb: [0.72, 0.5, 1.0], css: '#b891ff', need: 'A full passport' },
  { id: 'rose', name: 'Rosewick rose', rgb: [1.0, 0.42, 0.62], css: '#ff7fa6', need: 'All eight lost things returned' },
  { id: 'frost', name: 'Frost blue', rgb: [0.55, 0.85, 1.0], css: '#8fd6ff', need: 'Six jobs done in all' },
];
