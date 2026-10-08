# Other visitors: the server

`party/server.ts` is a small relay running on Cloudflare Workers with one Durable Object, written with
[`partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) (Cloudflare's successor to
PartyKit's server runtime). Everyone on the site joins one room, `park`, at `/parties/main/park`; the browser side uses
`partysocket`, as with PartyKit. The server gives each connection a short id and a two-word name ("Quiet Moth", "Amber
Lantern"). It passes walkers' states on to everyone else, tells a newcomer who is already here, and announces when
someone leaves. It keeps nothing: no history, no storage (the Durable Object's SQLite store is never written), no
accounts. Nothing about a connection (address, headers, the browser) is ever sent to anyone. The site itself (GitHub
Pages) does not change: the client is `fx/multiplayer/index.js`.

## Deploy (the owner, once)

```bash
cd Lanternfall-3D
npm install              # wrangler, partyserver, partysocket; dev only (node_modules/ is not committed)
npx wrangler login       # opens Cloudflare in the browser (a free account is enough)
npx wrangler deploy      # reads wrangler.toml: worker "lanternfall-3d", Durable Object class Park (SQLite-backed)
```

`npx wrangler deploy` ends by printing the address, `https://lanternfall-3d.<account subdomain>.workers.dev`. The account
subdomain is chosen once per Cloudflare account; the first deploy asks for one if the account has none (later:
dashboard, Workers & Pages, the subdomain on the right). Check it:

```bash
curl https://lanternfall-3d.<account subdomain>.workers.dev/parties/main/park     # {"ok":true,"n":0,"max":64}
```

Then point the live site at it: put the host in **`data/mp.json`** and push that one file:

```json
{ "host": "lanternfall-3d.<account subdomain>.workers.dev" }
```

(the URL exactly as wrangler printed it also works: `https://` and a trailing `/` are ignored). Logs: `npx wrangler tail`.
Remove it: `npx wrangler delete`.

**Free plan.** It fits the Workers Free plan: SQLite-backed Durable Objects are the kind it allows (`new_sqlite_classes`
in `wrangler.toml`); the older key-value-backed ones need the paid plan. The free plan's daily limits are 100,000
requests and 13,000 GB-s of Durable Object duration. Incoming WebSocket messages count as one request per 20; outgoing
ones are free. One visitor walking sends about 10 messages a second, which is about 1,800 requests an hour, so the free
plan covers roughly 50 visitor-hours of walking a day (Tour and Explore cost almost nothing: one message per 25 s). The
room is not hibernated (the visitors live in memory while anyone is connected), so duration is counted while anyone is
connected: one room for a whole day is about 11,000 GB-s, within the limit. When a limit is reached Cloudflare refuses
connections until the next day, and the page carries on alone, as when the server is away.

## Which host the page uses

1. `#mp=<host[:port]>` in the address, for one visit (tests, a local server): `index.html#mp=127.0.0.1:8970`.
2. Else `data/mp.json`, `{ "host": "..." }`, fetched once when the park has loaded. Keep the file there (an empty host
   is fine): a missing file would show up as a 404 in the console.
3. Else `HOST` at the top of `fx/multiplayer/index.js` (empty in the repository).

With no host at all, nothing connects and nothing is shown. Local addresses (`localhost`, `127.0.0.1`, `192.168.*`,
`10.*`) use `ws://` and `http://`; everything else uses `wss://` and `https://`. The client library is `partysocket`,
pinned in the import map in `index.html` (`https://unpkg.com/partysocket@1.3.0/dist/index.js`).

If the host is set but the server cannot be reached, the page asks for it once a minute from a small Worker and shows
nothing. Chrome still prints its own network notice for that request in DevTools, under the Worker; the page itself logs
nothing.

## Run locally

```bash
npm install
npx wrangler dev --port 8970 --ip 127.0.0.1          # the server, on http://127.0.0.1:8970 (no login needed)
python3 -m http.server 8962                           # the site, in another terminal
# open http://127.0.0.1:8962/index.html#mp=127.0.0.1:8970 in two windows and walk in both (key 3)
node tools/multiplayer/test.mjs http://127.0.0.1:8962/index.html   # starts its own wrangler dev on 8970; stop yours first
node tools/multiplayer/bots.mjs 8 --host 127.0.0.1:8970             # eight pretend walkers at the East Gate
node tools/multiplayer/cost.mjs http://127.0.0.1:8962/index.html    # frame time with 0, 8 and 24 others
```

## Why not PartyKit's hosting

The server was first written for PartyKit's own platform (`npx partykit deploy`, host
`lanternfall-3d.<github user>.partykit.dev`). The deploy registers the project but fails to give it an address: the
shared `partykit.dev` zone has reached Cloudflare's limit of 10,000 custom domains ("You have exceeded the limit of
10000 Workers custom domains on zone 'partykit.dev'", PartyKit issue #985). The project is still listed under the
owner's PartyKit account and can be removed with `npx partykit delete --name lanternfall-3d`. The same server runs on
the owner's own Cloudflare account through `partyserver` instead, with the same URLs and client. Moving back would only
take a `partykit.json` and the PartyKit `Party.Server` signatures.

## Wire format (JSON arrays, text frames)

The frame is Blender's, as in `game.player`: `x` east, `y` north, `z` up (the feet), metres; three.js is `(x, z, -y)`.
`yaw` is `game.player.yaw` (the walker's heading, radians, wrapped to -π..π by the server).

Client to server:

| Message | Meaning |
|---|---|
| `["s", kind, x, y, z, yaw, anim, frame, t, land]` | a walker's state. `kind` 1 = Wick, 2 = first person. `anim`: the platformer's animation id (`fx/platformer/anims.js`, 0..208) for Wick, -1 for first person. `frame`: the animation frame (1/30 s units, fractional, 0..400). `t`: the sender's `performance.now()` in ms (whole numbers; receivers interpolate on each sender's own timeline). `land`: a place id (`spire`, `gate`, `wanderers`, `meridian`, `frostmere`, `guildhollow`, `rosewick`, `lantern-row`, `brinewatch`) or `null`. Sent 10 times a second while moving, twice a second while still, and as soon as the animation changes (at most every 70 ms) |
| `["p"]` | here but not walking (Tour, Explore, a hidden tab). Also the keep-alive, every 25 s at the latest |

Server to client:

| Message | Meaning |
|---|---|
| `["w", id, name, [[id, name, state or null], ...]]` | welcome: your id and name, and everyone already in the room (`state` is the last `[kind, x, ... land]`, or `null` if not walking) |
| `["j", id, name]` | someone arrived |
| `["s", id, kind, x, y, z, yaw, anim, frame, t, land]` | someone's state (validated, rounded: positions to 1 cm, yaw to 0.001, frame to 0.1) |
| `["p", id]` | someone stopped walking (still here; stop drawing them) |
| `["l", id]` | someone left |
| `["f"]` | the park is full (64); the connection is then closed with code 4001 and the client walks alone, asking again in five minutes |

`GET /parties/main/park` answers `{"ok":true,"n":<visitors>,"max":64}` (with `access-control-allow-origin: *`). The
client asks this before it opens a socket.

What the server checks: the room must be `park` (any other path gets a 404 from the Worker, before any Durable Object); a connection id (`_pk`, chosen by the client) already in the room is refused (4005); a message is at most 200 characters,
JSON, one of the shapes above; positions inside the park's box (x -320..400, y -280..280, z -30..160); every number
finite; `anim` a whole number in range and -1 exactly for first person; `land` from the list. Anything else is dropped
(after 200 dropped messages the connection is closed, 4002). At most 15 messages a second per visitor (a bucket of 20);
the rest are dropped. A connection silent for 150 s is closed (4003). The server re-serialises what it relays: no text
from a client is passed on as it came.

### Sizes

A state is about 60 characters upstream and 68 downstream (the id added), plus 2 to 6 bytes of WebSocket framing. Measured numbers are in the
report of `tools/multiplayer/test.mjs` (`bytesRunning`, `bytesStill`).

## For `fx/multiplayer/avatars.js`

`fx/multiplayer/index.js` calls, on the figures module:

```js
createAvatars({ THREE, scene, surface, guests, manifest, game })
upsert(id, { name, kind: 'wick' | 'fp', x, y, z, yaw, anim, frame, t })   // every state that arrives
remove(id)                                                                // stopped walking or left: fade out
update(dt, time, camera)                                                  // every frame, after the local player has moved
setVisible(on)                                                            // off in Tour and when "Other visitors" is off
count, dispose()
```

The test (`tools/multiplayer/test.mjs`) also reads an optional `list` getter, `[{ id, name, kind, anim, fade, pos }]`
(`pos` a three.js position), to check where and what is drawn. `fx/multiplayer/avatars-stub.js` has it.

## Frame-time reports (`/api/frames`)

The same worker takes the page's frame-time reports (`fx/telemetry.js`; what is sent: the README, "Other visitors").
`POST /api/frames` with a JSON body as `text/plain` (so `navigator.sendBeacon` needs no preflight); the report is
rebuilt in `party/frames.ts` from known, typed, length-bounded fields and kept in a second SQLite-backed Durable Object,
`Frames` (binding and migration `v2` in `wrangler.toml`): at most 20,000 reports and 30 days, at most 60 per visit id.
Nothing about the connection is read. Reading needs a secret, set once:

```bash
npx wrangler secret put READ_KEY          # any long random string; without it the reports cannot be read back
LF_READ_KEY=<that string> node tools/telemetry/read.mjs --days 7          # per device: frame times, presets, loads, errors
node tools/telemetry/read.mjs --key <key> --visits                          # one line per visit
```

Locally: `npx wrangler dev --port 8970 --var READ_KEY:test`, then open the page with
`#mp=127.0.0.1:8970,telemetry` (`#telemetry` sends reports even from a local address) and read them with
`node tools/telemetry/read.mjs --host 127.0.0.1:8970 --key test`. Cost on the free plan: about 6-10 requests per visit
(a report is one Worker request plus one Durable Object request), next to the visitors' sockets.
