// Audit of fx/platformer/sm64.wasm: what it imports and exports, how big its code and data are, and a check that no
// model, texture, display-list, audio or ROM-reading code or data was linked.
// usage: node tools/platformer/audit-wasm.mjs fx/platformer/sm64.wasm [linker map]
import fs from 'node:fs';
const [file, mapFile] = process.argv.slice(2);
const buf = fs.readFileSync(file), mod = new WebAssembly.Module(buf);
const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
// section sizes
const sec = {}; let p = 8;
const leb = () => { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
while (p < buf.length) { const id = buf[p++], n = leb(); sec[id] = (sec[id] || 0) + n; p += n; }
const names = { 1: 'type', 2: 'import', 3: 'function', 5: 'memory', 6: 'global', 7: 'export', 10: 'code', 11: 'data', 0: 'custom' };
const sizes = Object.fromEntries(Object.entries(sec).map(([k, v]) => [names[k] || k, v]));
// forbidden symbols (the linker map lists every function and data object that made it into the output)
const BAD = /mario_geo|model\.inc|_dl_|display_list|gfx_adapter|load_mario_textures|load_mario_anims_from_rom|mio0|n64graphics|raw2rgba|load_audio_banks|synthesis|seqplayer|audio_init|sound_banks|gSoundDataADSR|texture/i;
let bad = [], dataSyms = [];
if (mapFile && fs.existsSync(mapFile)) {
  const lines = fs.readFileSync(mapFile, 'utf8').split('\n');
  for (const l of lines) {
    const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\S.*)$/.exec(l); if (!m) continue;
    const name = m[4].trim();
    if (BAD.test(name) && !/display_list_pool/.test(name)) bad.push(name);     // memory.c's (unused) pool allocator is not model data
    if (/^\.(data|rodata|bss)\./.test(name) || /\.(data|rodata|bss)$/.test(name)) dataSyms.push([parseInt(m[3], 16), name]);
  }
}
// The only sizeable data are the decompilation's sine / arctangent tables (gSineTable 20 KB, gArctanTable 2 KB in
// math_util.c) and small movement tables; more than 40 KB of data would mean something else got linked.
// the ROM's internal name must not appear anywhere in the binary
const romName = Buffer.from('SUPER MARIO 64');
const hasRomName = buf.indexOf(romName) >= 0;
// nor the character's name: exports are park_* only and the library's debug messages are compiled out
const nameHits = (buf.toString('latin1').match(/mario/gi) || []).length;
dataSyms.sort((a, b) => b[0] - a[0]);
const ok = !bad.length && !hasRomName && nameHits === 0 && (sizes.data || 0) < 40000 && imports.every((i) => /^(env\.(play_sound|stop_sound|play_music|stop_background_music|fadeout_background_music)|wasi_snapshot_preview1\.\w+)$/.test(i));
console.log(JSON.stringify({ file, bytes: buf.length, sizes, imports, exports: exports.length, parkExports: exports.filter((e) => /^park_/.test(e)), otherExports: exports.filter((e) => !/^park_/.test(e)),
  largestData: dataSyms.slice(0, 12).map(([n, s]) => `${n} ${s}`), forbidden: bad, romNameInBinary: hasRomName, nameHits, ok }, null, 1));
if (!ok) process.exit(1);
