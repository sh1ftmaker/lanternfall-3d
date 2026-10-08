// Lanternfall 3D: frame-time reports (fx/telemetry.js -> POST /api/frames -> tools/telemetry/read.mjs).
// One SQLite-backed Durable Object ("frames") keeps a rolling window: reports older than KEEP_DAYS or beyond MAX_ROWS
// are deleted as new ones arrive. A report is rebuilt here from known fields with checked types and lengths, so nothing
// else a client sends is stored. Nothing about the connection is read or kept: no address, no headers, no cookies; the
// only id is the random per-visit one the page makes (it lives in the page's memory and dies with the tab).
// Reading needs the READ_KEY secret (`npx wrangler secret put READ_KEY`); without it the reports cannot be read back.
import { DurableObject } from "cloudflare:workers";

const KEEP_DAYS = 30, MAX_ROWS = 20_000;      // whichever bites first
const MAX_BODY = 6_000;                       // bytes; a report is ~1-2 kB
const PER_VISIT = 60;                         // reports kept per visit id (the client sends ~10 in an hour)

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function frames(v: unknown) {
  const f = obj(v);
  return { n: num(f.n, 0, 1e7), med: num(f.med, 0, 2000), p90: num(f.p90, 0, 2000), p99: num(f.p99, 0, 2000), slow: num(f.slow, 0, 1), jank: num(f.jank, 0, 1), fps: num(f.fps, 0, 500) };
}
// the stored form of a report: every field named, typed and bounded
export function clean(raw: unknown) {
  const r = obj(raw), d = obj(r.dev), v = obj(r.view), l = obj(r.load);
  const sid = str(r.sid, 16);
  if (!sid || !/^[a-z0-9]{8,16}$/.test(sid)) return null;
  return {
    v: num(r.v, 0, 99), sid, seq: num(r.seq, 0, 1000), why: str(r.why, 12), t: num(r.t, 0, 1e7),
    build: str(r.build, 24),
    dev: { cls: str(d.cls, 8), os: str(d.os, 12), osv: str(d.osv, 8), br: str(d.br, 12), brv: str(d.brv, 8), gpu: str(d.gpu, 96), cores: num(d.cores, 0, 256), mem: num(d.mem, 0, 64),
      sw: num(d.sw, 0, 20000), sh: num(d.sh, 0, 20000), dpr: num(d.dpr, 0, 8), touch: bool(d.touch) },
    view: { q: str(v.q, 12), chosen: bool(v.chosen), steps: num(v.steps, 0, 20), pr: num(v.pr, 0, 8), cw: num(v.cw, 0, 20000), ch: num(v.ch, 0, 20000), mode: str(v.mode, 8), weather: str(v.weather, 8), guests: bool(v.guests) },
    load: { ready: num(l.ready, 0, 1e6), walk: num(l.walk, 0, 1e6), failed: bool(l.failed), lost: num(l.lost, 0, 999) },
    win: frames(r.win), all: frames(r.all),
    err: Array.isArray(r.err) ? r.err.slice(0, 5).map((e) => str(e, 160)).filter(Boolean) : [],
  };
}

export class Frames extends DurableObject {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sid TEXT NOT NULL, seq INTEGER, body TEXT NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS reports_at ON reports(at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS reports_sid ON reports(sid)");
  }
  add(body: string): number {
    if (body.length > MAX_BODY) return 413;
    let raw: unknown; try { raw = JSON.parse(body); } catch { return 400; }
    const r = clean(raw); if (!r) return 400;
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM reports WHERE sid = ?", r.sid).one().n as number;
    if (n >= PER_VISIT) return 429;
    const now = Date.now();
    this.sql.exec("INSERT INTO reports (at, sid, seq, body) VALUES (?, ?, ?, ?)", now, r.sid, r.seq ?? 0, JSON.stringify(r));
    this.sql.exec("DELETE FROM reports WHERE at < ?", now - KEEP_DAYS * 86_400_000);
    this.sql.exec("DELETE FROM reports WHERE id <= (SELECT id FROM reports ORDER BY id DESC LIMIT 1 OFFSET ?)", MAX_ROWS);
    return 204;
  }
  // the reports of the last `days` days, oldest first, each with the time it arrived (ms)
  list(days: number): unknown[] {
    const since = Date.now() - Math.min(KEEP_DAYS, Math.max(0.01, days)) * 86_400_000;
    return [...this.sql.exec("SELECT at, body FROM reports WHERE at >= ? ORDER BY id", since)].map((row) => ({ at: row.at, ...JSON.parse(row.body as string) }));
  }
}

const HEAD = { "access-control-allow-origin": "*", "cache-control": "no-store" };
interface Env { Frames: DurableObjectNamespace<Frames>; READ_KEY?: string }
// POST /api/frames (a report, text/plain JSON so a sendBeacon needs no preflight); GET /api/frames?days=7 with
// 'authorization: Bearer <READ_KEY>' to read them back
export async function framesRoute(req: Request, env: Env): Promise<Response> {
  if (!env.Frames) return new Response(null, { status: 404, headers: HEAD });
  const stub = env.Frames.get(env.Frames.idFromName("frames"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEAD, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
  if (req.method === "POST") {
    const len = +(req.headers.get("content-length") || 0);
    if (len > MAX_BODY) return new Response(null, { status: 413, headers: HEAD });
    const body = await req.text();
    return new Response(null, { status: await stub.add(body), headers: HEAD });
  }
  if (req.method === "GET") {
    const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.READ_KEY || key !== env.READ_KEY) return new Response("{}", { status: 403, headers: { ...HEAD, "content-type": "application/json" } });
    const days = +(new URL(req.url).searchParams.get("days") || 7);
    return new Response(JSON.stringify(await stub.list(days)), { headers: { ...HEAD, "content-type": "application/json" } });
  }
  return new Response(null, { status: 405, headers: HEAD });
}
