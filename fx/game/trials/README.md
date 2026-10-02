# trials: time trials

Three races against the clock and against your own ghost. Files: `index.js` (the module), `courses.js` (the data).

## What the visitor sees

- A **start post** (iron post, teal pennant, a faint glow, and its name when you are within 60 m) for each course. Walk
  up, tap the prompt (`E` in first person, or swing the lantern pole as Wick): "Race: the Lake Lap".
- A short 3-2-1 (skipped with Reduce motion), then the clock runs. The tracker line reads `Lake Lap 0:23.4 · 5 / 17`.
  Rings of light mark the checkpoints: the next one bright with a light column, the one after dim. They must be passed in
  order (within 5 m, 7 m up or down; the rooftop rings are tighter in height). A toast gives the split and the gap to your
  best (`5 / 17 0:23.1 -0.8`).
- A **ghost lantern** (a soft blue glow with a trail) replays your best run beside you. The first time, a dimmer "pace"
  ghost runs the checkpoint path at a modest fixed speed (6 m/s lake, 3 m/s swim, 5 m/s roofs; 0.6x in first person).
- The finish toast gives the time, whether it is a new best, and the medal. The journal's **Trials** section lists every
  course with best time, medal, a line on where its post is, and a "Take me there" button.
- Leaving the course (more than 110 / 130 / 80 m from the line), a teleport, leaving Walk, switching between Wick and first person, a camera takeover (photo mode, a ride) or using
  the start post again calls the race off, with a toast that says why. Starting another race over this one is quiet.
- A post's name fades while it would sit over the logo, the tracker or the buttons in the screen's top corners.

## The courses

| id | name | who | post (Blender x, y) | checkpoints |
|---|---|---|---|---|
| `lake` | The Lake Lap | Wick or first person | (103.6, 9), north of the lake steps at the East Gate end of the avenue | 17 along the promenade, about 535 m, each 4 m inland of the water's edge (the lake is not a circle: the south shore is 60 m out, the east 98 m) and kept inland of the Brinewatch bay; the last is the finish at the steps. The test bot's lap is 57 s |
| `swim` | The Spire Swim | Wick | (100.4, -8), the quay south of the steps | steps water (91, -3), mid lake (55, 1), the island beach post (18, -4), mid lake, back at the steps (95.5, -2) |
| `roof` | The Meridian Rooftops | Wick | (28.3, 98.8), the forecourt south of the Meridian Loop station | 4 rings on the roofs and the deck: (48.2, 126.9, 5.2), (59.1, 123.3, 10.4), (54.5, 106.5, 10), (56.3, 111.1, 11); the route is a long jump, a triple jump to the 5 m roof, then single jumps up to the 10 m deck |

Medals are by time (bronze = finish): see `medals` in `courses.js` (lake gold 66 s, silver 84 s). First-person bests are kept separately (key
`<course>.f`) and judged against the Wick times times `fp` (1.5 for the lake lap).

Props added: 3 posts (iron post, pennant, sphere, glow, label sprite), and during a race two ring markers with a light column and
glow, 7 ghost glow sprites, and (swim) a post on the island. All are removed when the race ends.

## Events (`game.on`)

`trials:start { course, style }`, `trials:checkpoint { course, index, count, time, best }`,
`trials:finish { course, time, best, newBest, medal, style }` (`style`: `w` Wick, `f` first person; `best` is the best time
after this run).

## Saved state (`game.save`, key `trials`)

`{ c: { 'lake.w': { runs, t, sp: [splits], g: { n, k: [keyframes], d: 'delta chars' }, m: medal 0-2 }, ... } }`. The ghost `g` is
10 samples a second, quarter-metre quantised, a keyframe every 60 samples and one character per component delta: about 3 KB
for a 90 s run. A run over 3000 samples (5 minutes) keeps every s-th sample (`g.s`, so about 3 KB per 100 s at most 10 KB), replayed with straight lines between them.

## Hash tokens

None. `#no-trials` skips the module.

## Public API (`game.modules.trials`)

`courses`, `start(id)`, `cancel()`, `race` (a snapshot or null), `best(id, style)`, `posts`, `encode`, `decode`, `medalOf`.

## Testing

`node tools/game/trials.test.mjs [url] [--quick] [--only course,lake,swim,roof,fp,phone] [--shots DIR]` (`--quick`: course data check, first person, phone; about 2 minutes, for every merge; the full run is about 12 minutes) (needs `puppeteer-core`). Wick is
driven with scripted input. The lake lap and the swim steer at the next checkpoint. The rooftop route comes from an
offline search with the real movement library on the park's own collision (a closed-loop driver, `tools/game/trials-agent.mjs`,
runs the legs in `tools/game/trials-roof.json`); the test drives the same legs in the live page.
