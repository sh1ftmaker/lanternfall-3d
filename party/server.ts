// Lanternfall 3D: the "other visitors" relay. One room ("park") for the whole site. The server gives each connection a
// short id and a two-word name, passes walkers' states on to everyone else, tells a newcomer who is already here, and
// keeps nothing: no history, no storage, nothing about the connection (address, headers) ever leaves this file.
// Runs on Cloudflare Workers + a Durable Object through `partyserver` (wrangler.toml); the URL layout is PartyKit's,
// /parties/main/park, so the `partysocket` client is unchanged. Wire format and deploying: party/README.md.
import { routePartykitRequest, Server, type Connection, type WSMessage } from "partyserver";

const ROOM = "park";
const MAX = 64;                       // visitors in the room; the 65th is told the park is full and walks alone
const MAX_BYTES = 200;                // a state message is about 70 bytes; anything bigger is ignored
const RATE = 15, BURST = 20;          // messages per second per visitor (token bucket); the rest are dropped
const IDLE_MS = 150_000;              // silent this long (the client says something every 25 s, hidden tabs every minute): dropped
const BAD_MAX = 200;                  // ignored messages before a connection is closed
// the park's bounds, Blender frame (x east, y north, z up, metres): the walk grid spans x -275..345, y -225..225
const X0 = -320, X1 = 400, Y0 = -280, Y1 = 280, Z0 = -30, Z1 = 160;
const ANIMS = 209;                    // platformer animation ids are 0..208; first-person visitors send -1
const LANDS = ["spire", "gate", "wanderers", "meridian", "frostmere", "guildhollow", "rosewick", "lantern-row", "brinewatch"];

const FIRST = ["Quiet", "Amber", "Gentle", "Drifting", "Silver", "Velvet", "Hushed", "Warm", "Misty", "Dusky", "Golden", "Little",
  "Wandering", "Starlit", "Paper", "Mossy", "Willow", "Slow", "Soft", "Moonlit", "Lantern", "Copper", "Dreaming", "Patient"];
const SECOND = ["Moth", "Lantern", "Heron", "Ember", "Owl", "Firefly", "Willow", "Candle", "Lark", "Fox", "Hare", "Wren",
  "Comet", "Reed", "Pebble", "Kite", "Lamplight", "Sparrow", "Ripple", "Thistle", "Beacon", "Clover", "Nightjar", "Puddle"];

type Walker = [kind: number, x: number, y: number, z: number, yaw: number, anim: number, frame: number, t: number, land: string | null];
interface Visitor { conn: Connection; id: string; name: string; state: Walker | null; seen: number; tokens: number; refill: number; bad: number }

const round = (v: number, k: number) => Math.round(v * k) / k;
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

// a state from a client: ["s", kind, x, y, z, yaw, anim, frame, t, land]; null if anything is off
function parseState(m: unknown[]): Walker | null {
  if (m.length !== 10) return null;
  const [, kind, x, y, z, yaw, anim, frame, t, land] = m;
  if (kind !== 1 && kind !== 2) return null;
  if (!num(x, X0, X1) || !num(y, Y0, Y1) || !num(z, Z0, Z1) || !num(yaw, -10, 10) || !num(frame, 0, 400) || !num(t, 0, 1e11)) return null;
  if (!Number.isInteger(anim) || (anim as number) < -1 || (anim as number) >= ANIMS || (kind === 2) !== (anim === -1)) return null;
  if (land !== null && !(typeof land === "string" && LANDS.includes(land))) return null;
  const a = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  return [kind, round(x, 100), round(y, 100), round(z, 100), round(a, 1000), anim as number, round(frame, 10), Math.round(t), land as string | null];
}

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store", "content-type": "application/json" };

// The one room. Not hibernating: the visitors live in memory for as long as anyone is connected (and are gone after).
export class Park extends Server {
  static options = { hibernate: false };
  visitors = new Map<string, Visitor>();      // by connection id
  timer: ReturnType<typeof setInterval> | null = null;

  onConnect(conn: Connection) {
    if (this.name !== ROOM) { conn.close(4004, "no such room"); return; }
    if (this.visitors.has(conn.id)) { conn.close(4005, "already connected"); return; }      // the client picks the connection id (_pk)
    if (this.visitors.size >= MAX) { conn.send(JSON.stringify(["f"])); conn.close(4001, "the park is full"); return; }
    const taken = new Set([...this.visitors.values()].flatMap((v) => [v.id, v.name]));
    let id = "", name = "";
    do id = Math.random().toString(36).slice(2, 7); while (id.length < 5 || taken.has(id));
    const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
    for (let i = 0; i < 60 && (!name || taken.has(name)); i++) { const a = pick(FIRST), b = pick(SECOND); if (a !== b) name = a + " " + b; }
    const now = Date.now();
    const others = [...this.visitors.values()].map((v) => [v.id, v.name, v.state]);
    this.visitors.set(conn.id, { conn, id, name, state: null, seen: now, tokens: BURST, refill: now, bad: 0 });
    conn.send(JSON.stringify(["w", id, name, others]));
    this.broadcast(JSON.stringify(["j", id, name]), [conn.id]);
    if (!this.timer) this.timer = setInterval(() => this.sweep(), 15_000);
  }

  onMessage(conn: Connection, message: WSMessage) {
    const v = this.visitors.get(conn.id); if (!v || v.conn !== conn) return;
    const now = Date.now(); v.seen = now;
    v.tokens = Math.min(BURST, v.tokens + (now - v.refill) * RATE / 1000); v.refill = now;
    if (v.tokens < 1) return;                         // over the rate: dropped (not counted as bad)
    v.tokens -= 1;
    let m: unknown = null;
    if (typeof message === "string" && message.length <= MAX_BYTES) { try { m = JSON.parse(message); } catch { m = null; } }
    if (!Array.isArray(m) || typeof m[0] !== "string") return this.bad(v);
    if (m[0] === "s") {
      const s = parseState(m); if (!s) return this.bad(v);
      v.state = s;
      this.broadcast(JSON.stringify(["s", v.id, ...s]), [conn.id]);
    } else if (m[0] === "p" && m.length === 1) {      // here, but not walking (Tour, Explore, a hidden tab); also the keep-alive
      if (v.state) { v.state = null; this.broadcast(JSON.stringify(["p", v.id]), [conn.id]); }
    } else this.bad(v);
  }

  bad(v: Visitor) { if (++v.bad > BAD_MAX) this.drop(v, 4002, "too many bad messages"); }
  drop(v: Visitor, code: number, why: string) { this.leave(v.conn); try { v.conn.close(code, why); } catch { /* already closed */ } }

  onClose(conn: Connection) { this.leave(conn); }
  onError(conn: Connection) { this.leave(conn); }
  leave(conn: Connection) {
    const v = this.visitors.get(conn.id); if (!v || v.conn !== conn) return;      // (a refused duplicate must not take the original with it)
    this.visitors.delete(conn.id);
    this.broadcast(JSON.stringify(["l", v.id]));
    if (!this.visitors.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  sweep() {
    const now = Date.now();
    for (const v of [...this.visitors.values()]) {
      if (now - v.seen > IDLE_MS) this.drop(v, 4003, "idle");
      else if (v.conn.readyState > 1) this.leave(v.conn);         // closed without a close event
    }
  }

  // GET: is the server up, and how many are here (the client asks before it opens a socket)
  onRequest(req: Request) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET" } });
    if (req.method !== "GET" || this.name !== ROOM) return new Response("{}", { status: 404, headers: CORS });
    return new Response(JSON.stringify({ ok: true, n: this.visitors.size, max: MAX }), { headers: CORS });
  }
}

interface Env { Main: DurableObjectNamespace<Park> }
export default {
  // only /parties/main/park reaches the Durable Object (binding "Main" = party "main"); anything else is answered here
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path !== `/parties/main/${ROOM}`) return new Response("{}", { status: 404, headers: CORS });
    return (await routePartykitRequest(req, env as unknown as Record<string, unknown>)) || new Response("{}", { status: 404, headers: CORS });
  },
};
