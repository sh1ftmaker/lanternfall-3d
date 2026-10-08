"""The one command for park -> web data. Works out what changed, bakes only that, packs, prints a timing table.

  uv run --no-project --with numpy --with scipy python web_export/build.py --out DATA_DIR [--draft | --full] [options]

Tiers
  --draft    no Cycles: changed parts get their geometry rebuilt and their lighting carried over from their last real
             bake (web_export/transfer.py); they are packed without hidden-surface removal and every other part is
             kept exactly as the last pack left it. For geometry and navigation work; about a minute.
  (default)  final quality for what changed: changed parts are baked (one Blender per part, in parallel as far as GPU
             memory allows), then everything is packed with HSR. Parts still holding draft lighting are baked too.
  --full     everything from scratch: scene rebuilt, every part baked, everything packed.

What counts as changed: a part whose source files (parts/<part>.py, parts/<part>_*.py, park_common.py, studio.py)
changed is rebuilt in the cached scene (web_export/scene.py); it is re-baked only if its fingerprint (meshes,
transforms, lights, materials) changed. A change to bake.py or to the world / render setup re-bakes everything.
Note: a part is lit in the context of the whole park, but only changed parts are re-baked; light that a changed part
throws on (or takes from) its neighbours is refreshed by the next --full (or --parts NEIGHBOUR).

Options
  --cache DIR      build state, scene cache and bake dumps (default ~/.cache/nocturne-park-build)
  --parts p,q      also (re)bake these parts
  --workers N      Blender processes at once (default: what free GPU memory and RAM allow, at most 3)
  --samples N      bake samples (default 64, as bake.py)
  --dry-run        print what would be done
  --no-ground      skip the ground-map bake (web_export/ground.py, ~10 min; pack keeps NPZ/ground_raw.npz)
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, time, glob
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import park_common as pc

ALL = ["core", "transit"] + pc.LAND_IDS
COST = dict(core=120, transit=90, trains=40, guildhollow=60, frostmere=70, meridian=70, wanderers=80, brinewatch=80,
            **{"lantern-row": 110, "rosewick": 100})
GPU_MB_PER_BAKE = 2000         # measured peak ~1.8 GB on the RTX 4060 (Guildhollow, whole park loaded)
RAM_MB_PER_BAKE = 4000         # measured peak RSS ~3.5 GB

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--out", required=True); ap.add_argument("--cache", default=os.path.expanduser("~/.cache/nocturne-park-build"))
g = ap.add_mutually_exclusive_group(); g.add_argument("--draft", action="store_true"); g.add_argument("--full", action="store_true")
ap.add_argument("--parts", default=""); ap.add_argument("--workers", type=int, default=0); ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--blender", default="blender"); ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--no-pack", action="store_true", help="bake only; pack later")
ap.add_argument("--no-ground", action="store_true", help="do not re-bake the ground maps (pack keeps the last ones)")
a = ap.parse_args()
CACHE = os.path.abspath(a.cache); OUT = os.path.abspath(a.out)
NPZ = os.path.join(CACHE, "npz"); FINAL = os.path.join(CACHE, "final"); LOGS = os.path.join(CACHE, "logs")
BLEND = os.path.join(CACHE, "scene.blend"); STATEF = os.path.join(CACHE, "state.json")
for d in (CACHE, NPZ, FINAL, LOGS, OUT): os.makedirs(d, exist_ok=True)
T0 = time.time(); TIMES = []
def log(*s): print("[build %5.0fs]" % (time.time() - T0), *s, flush=True)
class stage:
    def __init__(self, name): self.name = name
    def __enter__(self): self.t = time.time(); log("--", self.name); return self
    def __exit__(self, *e): TIMES.append((self.name, time.time() - self.t))

def sha(*paths, extra=b""):
    h = hashlib.sha1(extra)
    for p in paths: h.update(os.path.basename(p).encode()); h.update(open(p, "rb").read())
    return h.hexdigest()

def src_hash(part):
    mod = part.replace("-", "_")
    fs = sorted(set(glob.glob(os.path.join(ROOT, "parts", mod + ".py")) + glob.glob(os.path.join(ROOT, "parts", mod + "_*.py"))))
    return sha(*fs, os.path.join(ROOT, "park_common.py"), os.path.join(ROOT, "studio.py"))

def global_hash():
    """everything outside the parts that changes how the park is lit: bake.py and the world / render setup"""
    src = open(os.path.join(ROOT, "park_common.py")).read()
    fns = "".join(m.group(0) for m in re.finditer(r"^def (setup_world|_enable_gpu|setup_render)\(.*?(?=^def |\Z)", src, re.S | re.M))
    return sha(os.path.join(HERE, "bake.py"), os.path.join(HERE, "lampshape.py"), extra=(fns + "samples=%d" % a.samples).encode())

def run(cmd, logf, cwd=ROOT):
    with open(logf, "w") as fh:
        return subprocess.run(cmd, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT).returncode

state = json.load(open(STATEF)) if os.path.exists(STATEF) else {}
sp = state.setdefault("parts", {})
forced = {p for p in a.parts.split(",") if p}
bad = forced - set(ALL)
if bad: sys.exit("unknown part(s): %s" % ", ".join(sorted(bad)))

# ───────────── 1. what changed ─────────────
with stage("fingerprint"):
    src = {p: src_hash(p) for p in ALL}; gh = global_hash()
    if a.full or not os.path.exists(BLEND):
        rebuild = set(ALL)
    else:
        rebuild = {p for p in ALL if sp.get(p, {}).get("src") != src[p]}
    log("source changed:", sorted(rebuild) or "nothing")
    if rebuild and not a.dry_run:
        if a.full and os.path.exists(BLEND): os.remove(BLEND)
        cmd = [a.blender, "-b", "-P", os.path.join(HERE, "scene.py"), "--", "--blend", BLEND, "--state", os.path.join(CACHE, "scene_state.json"),
               "--rebuild", ",".join(sorted(rebuild))]
        if run(cmd, os.path.join(LOGS, "scene.log")): sys.exit("scene.py failed, see " + os.path.join(LOGS, "scene.log"))
        geo = {p: v["geo"] for p, v in json.load(open(os.path.join(CACHE, "scene_state.json")))["parts"].items()}
    else:
        geo = {p: sp.get(p, {}).get("geo") for p in ALL}
    have = lambda p: os.path.exists(os.path.join(NPZ, "part__%s.npz" % p))
    geo_changed = {p for p in ALL if sp.get(p, {}).get("geo") != geo[p] or not have(p)}
    if a.draft:
        dirty = geo_changed | forced
    elif a.full or state.get("global") != gh:
        if state.get("global") and not a.full: log("bake.py / world setup changed: everything is re-baked")
        dirty = set(ALL)
    else:
        dirty = geo_changed | forced | {p for p in ALL if sp.get(p, {}).get("light") != "final"}
    dirty = [p for p in ALL if p in dirty]
    log("to bake (%s):" % ("draft" if a.draft else "final"), dirty or "nothing")
if a.dry_run: sys.exit(0)

def save_state():
    state["global"] = state.get("global") if a.draft else gh
    json.dump(state, open(STATEF, "w"), indent=1)

# ───────────── 2. bake ─────────────
def free_slots():
    k = 3
    try:
        free = int(subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout.split()[0])
        k = min(k, free // GPU_MB_PER_BAKE)
    except Exception: pass
    try:
        av = int(next(l for l in open("/proc/meminfo") if l.startswith("MemAvailable")).split()[1]) // 1024
        k = min(k, av // RAM_MB_PER_BAKE)
    except Exception: pass
    return max(1, k)

def bake_cmd(out, export, extra=()):
    return [a.blender, "-b", "-P", os.path.join(HERE, "bake.py"), "--", "--out", out, "--scene-blend", BLEND, "--export", export,
            "--samples", str(a.samples)] + list(extra)

def install(stage_dir, final):
    for f in glob.glob(os.path.join(stage_dir, "*.npz")) + glob.glob(os.path.join(stage_dir, "lights__*.json")):
        shutil.copy2(f, os.path.join(NPZ, os.path.basename(f)))
        if final: shutil.copy2(f, os.path.join(FINAL, os.path.basename(f)))

JOBT = {}
if dirty and a.draft:
    with stage("geometry (no Cycles)"):
        sd = os.path.join(CACHE, "stage", "draft"); shutil.rmtree(sd, ignore_errors=True)
        if run(bake_cmd(sd, ",".join(dirty), ["--draft"]), os.path.join(LOGS, "draft.log")):
            sys.exit("bake.py --draft failed, see " + os.path.join(LOGS, "draft.log"))
    with stage("light transfer"):
        sys.path.insert(0, HERE); import transfer, numpy as np
        for p in dirty:
            prev = os.path.join(FINAL, "part__%s.npz" % p)
            if not os.path.exists(prev): prev = os.path.join(NPZ, "part__%s.npz" % p)
            new = transfer.load(os.path.join(sd, "part__%s.npz" % p))
            out, st = transfer.transfer(new, transfer.load(prev) if os.path.exists(prev) else None)
            np.savez(os.path.join(sd, "part__%s.npz" % p), **out)
            log("  %-12s %7d tris: %d unchanged (light kept exactly), %d with nearby light, %d fallback" % (p, st["tris"], st["exact"], st["near"], st["fallback"]))
        install(sd, False)
        for p in dirty: sp.setdefault(p, {}).update(src=src[p], geo=geo[p], light="draft")
        save_state()
elif dirty:
    with stage("bake (Cycles)"):
        jobs = []
        for p in dirty:
            if p == "transit":
                jobs += [("transit", ["--no-trains"]), ("trains", ["--trains-only"])]
            else: jobs.append((p, []))
        jobs.sort(key=lambda j: -COST.get(j[0], 60))
        width = a.workers or free_slots(); log("bake jobs: %d, %d at once" % (len(jobs), width))
        running = {}; queue = list(jobs); tried = {}
        while queue or running:
            while queue and len(running) < width:
                name, extra = queue.pop(0); sd = os.path.join(CACHE, "stage", name); shutil.rmtree(sd, ignore_errors=True)
                export = "transit" if name == "trains" else name
                fh = open(os.path.join(LOGS, "bake_%s.log" % name), "w")
                pr = subprocess.Popen(bake_cmd(sd, export, extra), cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT)
                running[name] = (pr, time.time(), extra, sd, fh); log("  start %-12s (pid %d)" % (name, pr.pid))
            time.sleep(0.5)
            for name, (pr, t, extra, sd, fh) in list(running.items()):
                if pr.poll() is None: continue
                fh.close(); del running[name]; JOBT[name] = time.time() - t
                txt = open(os.path.join(LOGS, "bake_%s.log" % name), errors="replace").read()
                ok = pr.returncode == 0 and re.search(r"^\[bake +\d+s\] done\s*$", txt, re.M) is not None
                if ok:
                    install(sd, True); log("  done  %-12s %5.0fs" % (name, JOBT[name]))
                    if name != "trains": sp.setdefault(name, {}).update(src=src[name], geo=geo[name], light="final")
                    continue
                oom = re.search(r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|OPTIX_ERROR|cuMemAlloc|System is out of GPU", txt, re.I)
                if oom and width > 1 and tried.get(name, 0) < 2:
                    width -= 1; tried[name] = tried.get(name, 0) + 1; queue.insert(0, (name, extra))
                    log("  %s ran out of GPU memory: retrying with %d at once" % (name, width))
                else:
                    sys.exit("bake of %s failed (exit %s), see %s" % (name, pr.returncode, os.path.join(LOGS, "bake_%s.log" % name)))
        save_state()
        for n, t in sorted(JOBT.items(), key=lambda x: -x[1]): TIMES.append(("  bake " + n, t))
else:
    save_state()

# ───────────── 2b. ground maps (Cycles; web_export/ground.py) ─────────────
# after a real bake (any part), on the walk grid of the last pack (NPZ/nav_debug.npy); --no-ground skips it
navf = os.path.join(NPZ, "nav_debug.npy")
if dirty and not a.draft and not a.no_ground and os.path.exists(navf):
    with stage("ground maps (Cycles)"):
        if run([a.blender, "-b", "-P", os.path.join(HERE, "ground.py"), "--", "--npz", NPZ, "--scene-blend", BLEND], os.path.join(LOGS, "ground.log")):
            sys.exit("ground.py failed, see " + os.path.join(LOGS, "ground.log"))

# ───────────── 3. pack ─────────────
if a.no_pack: TIMES.append(("pack (skipped)", 0.0))
else:
    with stage("pack"):
        keep = []
        if a.draft:
            recs = os.path.join(CACHE, "pack")
            keep = [p for p in ALL if p not in dirty and os.path.exists(os.path.join(recs, p + ".json"))]
        cmd = ["uv", "run", "--no-project", "--with", "numpy", "--with", "scipy", "python", os.path.join(HERE, "pack.py"), NPZ, OUT,
               "--state", os.path.join(CACHE, "pack")] if shutil.which("uv") and not os.environ.get("BUILD_NO_UV") else \
              [sys.executable, os.path.join(HERE, "pack.py"), NPZ, OUT, "--state", os.path.join(CACHE, "pack")]
        if a.draft: cmd += ["--no-hsr"] + (["--keep", ",".join(keep)] if keep else [])
        rc = run(cmd, os.path.join(LOGS, "pack.log"))
        txt = open(os.path.join(LOGS, "pack.log")).read()
        if rc: print(txt[-3000:]); sys.exit("pack.py failed, see " + os.path.join(LOGS, "pack.log"))
        def at(rx):
            ts = [int(m.group(1)) for m in re.finditer(r"\[pack +(\d+)s\] (?:" + rx + ")", txt)]
            return ts[-1] if ts else None
        marks = [("  read + weld", at("processed|kept")), ("  hsr", at("hsr: removed")), ("  encode", at("TOTAL")),
                 ("  trains, extras, nav", at("manifest written"))]
        prev = 0
        for n, t in marks:
            if t is not None: TIMES.append((n + " (pack log)", t - prev)); prev = t
        for line in txt.splitlines():
            if "TOTAL" in line or "manifest written" in line: log(line.strip())
        state["pack"] = dict(draft=a.draft, parts_kept=keep); save_state()

print("\n%-28s %8s" % ("stage", "seconds"))
for n, t in TIMES: print("%-28s %8.1f" % (n, t))
print("%-28s %8.1f" % ("TOTAL", time.time() - T0))
