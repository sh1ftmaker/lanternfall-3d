"""Dump per-object bounding boxes (Blender frame) from the baked npz dumps, to place sound sources.
usage: python objects_dump.py <npz_dir> <out.json>"""
import sys, json, glob, os
import numpy as np
out = {}
for f in sorted(glob.glob(os.path.join(sys.argv[1], 'part__*.npz'))):
    d = np.load(f, allow_pickle=True)
    names = json.loads(str(d['meta']))['names']
    co, tri, oid = d['co'], d['tri'], d['oid']
    v = co[tri[:, 0]]
    order = np.argsort(oid, kind='stable')
    oids = oid[order]; vv = v[order]
    u, start = np.unique(oids, return_index=True)
    ends = list(start[1:]) + [len(oids)]
    for o, s, e in zip(u, start, ends):
        p = vv[s:e]
        lo, hi = p.min(0), p.max(0)
        out[names[o]] = [round(float(x), 2) for x in (*((lo + hi) / 2), *lo, *hi)]
    print(f, len(u))
json.dump(out, open(sys.argv[2], 'w'))
