// The crowd drifts to what is on: weights on where guests choose to go next (fx/guests/sim.js params.bias, sent to the
// Worker). Only new choices are biased, so nobody turns round mid-walk and the shift takes a few minutes to show.
export const SHRINE = [36, -183];            // the ghost-story stage on the shrine terrace (see story.js)

export function biasFor(t) {
  if (t < 19 * 60) return null;
  if (t < 21 * 60 + 15) return { lands: { frostmere: 3 } };                                           // the Frost Fair
  if (t < 22 * 60) return { lands: { 'lantern-row': 2.2 }, pts: [{ x: SHRINE[0], y: SHRINE[1], r: 25, k: 2.5 }] };   // the stories
  if (t < 22 * 60 + 30) return { rail: 1.2 };
  if (t < 23 * 60) return { rail: 1.7 };                                                              // the lake, before the fall
  return { rail: 2.4 };                                                                               // and during it
}

let sent = '';
export function drift(game, t) {
  const g = game.guests, c = g && g.crowd; if (!c || !c.setParams) return;
  const b = biasFor(t), k = JSON.stringify(b);
  if (k === sent) return; sent = k; c.setParams({ bias: b });
}
