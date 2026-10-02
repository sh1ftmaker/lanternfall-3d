// The lamplighter before Wick: five scratched posts (land, index into LAMPS[land]) read in order, then the note.
export const TRAIL = [
  { n: 1, land: 'frostmere', k: 2, who: 'E.M. · the first', line: 'Lit this one in the cold. West from here, to the old guild stones.' },
  { n: 2, land: 'guildhollow', k: 2, who: 'E.M. · the second', line: 'Iron holds the heat. Next, where the roses grow in the dark.' },
  { n: 3, land: 'rosewick', k: 7, who: 'E.M. · the third', line: 'Petals on the path. Go on to the lanes that keep their wishes.' },
  { n: 4, land: 'lantern-row', k: 3, who: 'E.M. · the fourth', line: 'Smoke and paper, all night. Follow the smell of tar and salt.' },
  { n: 5, land: 'brinewatch', k: 2, who: 'E.M. · the fifth', line: 'The last is not on the quay. Try the tavern, by the fire.' },
];
export const NOTE = {
  title: 'A note, folded twice',
  body: [
    'To whoever carries the pole next. I lit every lamp in this park once, and the walk stayed bright until the gates closed.',
    'This last one I hid by the fire, where the tide-clock can hear it. Somebody ought to have to look for a light.',
    'Keep the pole dry. Leave one corner dark for the next of us, and tell no one how long it took.',
  ],
  sign: 'E.M.',
};
// where the extra lamp stands, and the old pole leans (Brine & Barrel, Brinewatch): [x, y, z]
export const HIDDEN = { land: 'brinewatch', at: [135.4, -21.2, 0.7], pole: [141.2, -16.4, 0.7] };
