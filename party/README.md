# Other visitors: the PartyKit server

`party/server.ts` is a small relay on [PartyKit](https://www.partykit.io/). Everyone on the site joins one room,
`park`. The server gives each connection a short id and a two-word name ("Quiet Moth", "Amber Lantern"). It passes
walkers' states on to everyone else, tells a newcomer who is already here, and announces when someone leaves. It keeps
nothing: no history, no storage, no accounts. Nothing about a connection (address, headers, the browser) is ever sent
to anyone. The site itself (GitHub Pages) does not change: the client is `fx/multiplayer/index.js`.

## Deploy (the owner, once)

```bash
cd Lanternfall-3D
npm install              # partykit + partysocket, dev only (node_modules/ is not committed)
npx partykit login       # opens GitHub in the browser; log in as the GitHub user that should own the project
npx partykit deploy      # reads partykit.json: project "lanternfall-3d", main party/server.ts
```

The server will then be at **`lanternfall-3d.<github user>.partykit.dev`**, so `lanternfall-3d.sh1ftmaker.partykit.dev`
for the `sh1ftmaker` account (`npx partykit deploy` prints the exact address). Check it with
`curl https://lanternfall-3d.sh1ftmaker.partykit.dev/parties/main/park`, which should answer `{"ok":true,"n":0,"max":64}`.
Nothing has to be pushed to GitHub Pages for this: the client already points there. Logs: `npx partykit tail`.
Remove it: `npx partykit delete`.

Until the server is deployed, the live page asks for it once a minute from a small Worker and shows nothing. Chrome
still prints its own network notice for that request in DevTools, under the Worker. The page itself logs nothing.

## Changing the host

`HOST` at the top of `fx/multiplayer/index.js` is the only place:

```js
export const HOST = 'lanternfall-3d.sh1ftmaker.partykit.dev';
```

For a single page load, `#mp=<host[:port]>` in the address overrides it, for example
`index.html#mp=127.0.0.1:8970`. Local addresses (`localhost`, `127.0.0.1`, `192.168.*`, `10.*`) use `ws://` and
`http://`; everything else uses `wss://` and `https://`. The client library is `partysocket`, pinned in the import map
in `index.html` (`https://unpkg.com/partysocket@1.3.0/dist/index.js`).

## Run locally

```bash
npm install
npx partykit dev --port 8970                      # the server, on http://127.0.0.1:8970
python3 -m http.server 8962                       # the site, in another terminal
# open http://127.0.0.1:8962/index.html#mp=127.0.0.1:8970 in two windows and walk in both (key 3)
node tools/multiplayer/test.mjs http://127.0.0.1:8962/index.html   # starts its own partykit dev on 8970; stop yours first
```

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

What the server checks: the room must be `park` (other rooms are closed, 4004); a message is at most 200 characters,
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
