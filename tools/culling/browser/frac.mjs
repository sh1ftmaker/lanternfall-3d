// The trees drawn for a forest fraction f are the same with the culling split as without (#no-cull).
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--use-angle=gl'] });
const open = async (h) => { const p = await browser.newPage(); await p.setViewport({ width: 800, height: 600 }); await p.goto(process.argv[2] + '#weather=clear,no-guests' + h); await p.waitForFunction('window.__park && window.__park.loaded', { timeout: 240000 }); return p; };
const [A, B] = [await open(''), await open(',no-cull')];
const F = [1, 0.55, 0.5, 0.25, 0.013, 0];
const key = 'const key = (a, o) => [12, 13, 14, 0, 2].map((i) => a[o + i].toFixed(4)).join(",");';
const a = await A.evaluate(`(() => { ${key} const F = ${JSON.stringify(F)}; return F.map((f) => __park.scene.children.filter((o) => o.isGroup && o.name.startsWith('forest-')).map((g) => { g.userData.setFraction(f); const buf = g.children[0].instanceMatrix.data.array, lim = Math.floor(g.userData.total * f); const s = []; for (let k = 0; k < lim; k++) s.push(key(buf, k * 16)); return s.sort().join(';'); })); })()`);
const b = await B.evaluate(`(() => { ${key} const F = ${JSON.stringify(F)}; return F.map((f) => __park.scene.children.filter((o) => o.isInstancedMesh && o.userData.total).map((im) => { const lim = Math.floor(im.userData.total * f), arr = im.instanceMatrix.array; const s = []; for (let k = 0; k < lim; k++) s.push(key(arr, k * 16)); return s.sort().join(';'); })); })()`);
F.forEach((f, i) => console.log('f', f, 'species', a[i].length, b[i].length, 'identical sets:', a[i].every((x, j) => x === b[i][j]), 'trees', a[i].reduce((s, x) => s + (x ? x.split(';').length : 0), 0)));
await browser.close();
