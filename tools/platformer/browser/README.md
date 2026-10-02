# Browser test scripts (puppeteer-core + system Chromium)

Copy this folder next to a `node_modules` that has `puppeteer-core` (ES module resolution starts from the script's
own folder), serve the repository root on a port, and run, for example:

    node run.mjs moves.mjs --url http://127.0.0.1:8851/index.html --hash '#pfdebug' [--only ring,ledge] [--shots] | python3 fmt.py
    node run.mjs parkshots.mjs --url http://127.0.0.1:8851/index.html
    node run.mjs lineup.mjs --url http://127.0.0.1:8851/platformer-lineup.html --until 'window.__lineup' --sets 0,1,2,3 --u 0.4 --w 1600 --h 600
    node pfunc.mjs http://127.0.0.1:8851/index.html          # functional + console, desktop and 390x844 touch (ANGLE GL)
    node pfperf.mjs 1920 1080 1                                # cost (Vulkan, vsync off)

`run.mjs` writes screenshots and `moves.json` to paths set at the top of the scripts (edit `OUT` / `--out`).
`moves.mjs` drives the Platformer through `__park.platformer.test` (scripted input in the world frame, a trace of
every library state, `teleport`), finds real walls / ledges / stairs / slopes by probing a second copy of the library
and the walk grid, and records the action sequence of each move.
