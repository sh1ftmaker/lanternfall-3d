// The crowd drifts to what is on: weights on where guests choose to go next (fx/guests/sim.js params.bias, sent to the
// Worker). Only new choices are biased, so nobody turns round mid-walk and the shift takes a few minutes to show.
export const STAGE = [33.6, -181];           // the ghost-story stage on the shrine terrace (raised, z 3.19)
const SHRINE = STAGE;

const BIASES = [
  null,                                                                                               // gates open: as the sim likes it
  { lands: { frostmere: 5 }, rail: 0.6 },                                                                        // the Frost Fair
  { lands: { 'lantern-row': 5 }, rail: 0.6, pts: [{ x: STAGE[0], y: STAGE[1], r: 25, k: 3 }] },              // the stories
  { lands: { lake: 1.5 }, rail: 1.2 }, { lands: { lake: 2.5 }, rail: 1.7 },                                                                       // the lake, before the fall
  { lands: { lake: 4 }, rail: 2.4 },                                                                                    // and during it
];
export function biasIndex(t) { return t < 19 * 60 ? 0 : t < 21 * 60 + 15 ? 1 : t < 22 * 60 ? 2 : t < 22 * 60 + 30 ? 3 : t < 23 * 60 ? 4 : 5; }

let sent = -1;
export function drift(game, t) {
  const g = game.guests, c = g && g.crowd; if (!c || !c.setParams) return;
  const k = biasIndex(t); if (k === sent) return; sent = k; c.setParams({ bias: BIASES[k] });
}
