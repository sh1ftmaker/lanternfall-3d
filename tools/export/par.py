"""Fork-based parallel map for pack.py / hsr.py (numpy work on one core per task, 16 cores on the build machine).

Workers are forked when pmap() is called, so they see the caller's arrays and closures as they are at that moment
(copy-on-write, nothing is pickled on the way in except the small per-task arguments). Results come back pickled, in
task order, so callers can concatenate them and get exactly what the serial loop produced.

PACK_WORKERS=1 runs everything serially in-process (same results).
"""
import os, multiprocessing as mp

def workers():
    return max(1, int(os.environ.get("PACK_WORKERS", min(12, os.cpu_count() or 1))))

_FN = [None]
def _run(args):
    return _FN[0](*args)

def pmap(fn, arglist, nproc=None):
    """[fn(*args) for args in arglist], with the calls spread over forked worker processes."""
    arglist = list(arglist)
    n = min(nproc or workers(), len(arglist))
    if n <= 1: return [fn(*a) for a in arglist]
    _FN[0] = fn
    ctx = mp.get_context("fork")
    with ctx.Pool(n) as pool:
        return pool.map(_run, arglist, chunksize=1)

def ranges(n, k):
    """k contiguous (lo, hi) ranges covering 0..n."""
    k = max(1, min(k, n)) if n else 1
    b = [round(i * n / k) for i in range(k + 1)]
    return [(b[i], b[i + 1]) for i in range(k)]
