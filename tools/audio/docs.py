"""Write data/audio/README.md (every file: what, how, loop points, loudness, size) and fx/audio/CREDITS.md
(licences and provenance) from render_meta.json, fetch/sources.json and audio.json. usage: python docs.py"""
import json, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
meta = json.load(open(os.path.join(HERE, 'render_meta.json')))
src = json.load(open(os.path.join(HERE, 'fetch', 'sources.json')))
aj = json.load(open(os.path.join(REPO, 'data', 'audio', 'audio.json')))

GROUP_DOC = {
    'footstep_stone': 'Boot steps on stone, cut from a CC0 recording (6 separated steps), loudness-matched to -27 LUFS.',
    'footstep_grass': 'Boot steps on grass, cut from a CC0 recording, loudness-matched.',
    'footstep_snow': 'Mountain-boot steps in snow, cut from a CC0 recording, loudness-matched.',
    'footstep_wood': 'Boot steps on wooden planks (the boots section of a CC0 shoe-variety recording), loudness-matched.',
    'footstep_gravel': 'Synthesised gravel crunch (grains of filtered noise + heel thump), loudness-matched.',
    'firework_launch': 'Synthesised mortar thump + rising whoosh, with a synthetic outdoor reverb.',
    'firework_burst': 'Synthesised shell burst: low boom, crackle tail, long outdoor reverb (3 big, 2 small).',
    'splash': 'Synthesised small splash: noise burst + droplet chirps + low plop.',
    'lantern_release': 'Synthesised hush of a lantern wave lifting: airy swell, paper crinkles, one soft glass note.',
    'ui_click': 'Synthesised soft wooden tick.',
    'oar': 'Synthesised oar stroke: water swirl, bubbles, a light knock on the gunwale.',
    'spire_bell': 'Synthesised (modal) church-type bell on D3, three slow strokes.',
    'anvil': 'Hammer on anvil: variant 1 a CC0 recording, 2-4 synthesised (inharmonic modes, short ring).',
    'strength_bell': 'Synthesised high striker: mallet thunk, puck rattle up the rail, bell ding.',
    'fanfare': 'Composed fanfare (D major) for two synthesised brass voices in fifths.',
    'ship_bell': "Synthesised ship's bell, two double strokes ('ding-ding, ding-ding').",
    'shrine_bell': 'Synthesised suzu jangle (small bells) and one deep temple-bell stroke.',
    'clappers': 'Synthesised hyoshigi (wooden clappers) struck before a ghost story.',
    'station_chime': 'Synthesised station chime: A5-F#5-D5 on soft tines + celesta.',
    'announce': 'Synthesised calm announcement: attention tone, then wordless formant syllables (no words).',
    'owl': 'Owl hoots cut from two CC0 recordings (a hooting owl; a tawny owl, band-limited to the hoot).',
    'dice': 'Dice on a wooden table: variant 1 a CC0 recording, 2-3 synthesised clacks.',
    'kettle': 'Synthesised simmering kettle (bubbles + soft steam, deliberately no whistle).',
    'skate': 'Skate blades carving ice, cut from a CC0 recording.',
    'ice_chimes': 'Synthesised falling glass-chime cluster in D major pentatonic, high and soft.',
    'creak': 'Synthesised timber creak (stick-slip pulses through wooden resonances).',
    'nightingale': 'Nightingale song phrases cut from a CC0 night recording.',
    'lamplighter': 'Synthesised lamp being lit: match strike, flare, soft gas whoomp, a little glass ring.',
    'door': "The Paper Doors: twelve short composed phrases, one per door, each a different timbre (music box, harp, "
            "celesta, glass harmonica, shakuhachi, choir, koto, glockenspiel, handbell, flute, e-piano, strings), "
            "all in D major pentatonic.",
}
ITEM_DOC = {
    'torch_loop': 'Torch flames crackling (CC0 recording, loop of flames).',
    'fountain_loop': 'A fountain in a square (CC0 recording).',
    'neon_hum': 'Synthesised neon/transformer hum (120 Hz harmonics + faint buzz), very low level.',
    'train_loop': 'Synthesised monorail running loop: motor whine, tyre rumble, rail joints each second, air rush.',
    'creak_loop': 'Mooring hawsers creaking (CC0 recording).',
    'sizzle_loop': 'Meat sizzling on a grill (CC0 recording).',
    'taiko_loop': 'Synthesised distant taiko pattern (72 bpm grid) in a large room.',
    'chimes_loop': 'Synthesised wind chimes in D major pentatonic, struck by gusts.',
    'ghost_hush': 'Synthesised hush near the ghost-story stage: breathy swells, a very soft D/A drone.',
    'crowd_sparse': 'Crowd density layer (sparse): a plaza with people walking and talking (CC0).',
    'crowd_murmur': 'Crowd density layer (murmur): large outdoor festival walla (CC0).',
    'crowd_dense': 'Crowd density layer (dense): steady talking in a theatre foyer (CC0).',
    'frost_drum': "The Frost Fair's stern drum: synthesised field drum + bass drum march cadence, 72 bpm.",
}


def where():
    """map file -> list of places it is used in audio.json"""
    w = collections.defaultdict(list)
    for z in aj['zones']:
        for k in ('bed', 'music'):
            if k in z:
                w[z[k]['file']].append(f"zone {z['id']} {k}" + (f" at {z[k]['pos']}" if 'pos' in z[k] else ''))
    for e in aj['emitters']:
        for f in e.get('files', [e['file']]):
            w[f].append(f"emitter {e['id']}" + (f" (follow {e['follow']})" if 'follow' in e else f" at {e['pos']}"))
    for c in aj.get('crowd', []):
        w[c['file']].append(f"crowd layer, density {c['density']}")
    for k, fs in aj['oneshots'].items():
        for f in fs:
            w[f].append(f'oneshots.{k}')
    return w


def credit(ids):
    return ', '.join(f"[fs{i}]({src[str(i)]['url']})" for i in ids) if ids else 'synthesised'


def readme():
    w = where()
    tot = collections.Counter()
    for v in meta.values():
        tot[v['cat']] += v['bytes']
    L = []
    L.append('# Lanternfall sound content (`data/audio/`)\n')
    L.append('Every sound the park makes: ambience beds, music, positioned emitters and one-shots, described by '
             '`audio.json` (format: `Blender-Park/web_export/BRIEF_WEB.md`, "The SOUND project"; player: `fx/audio/`). '
             'Everything here is either **synthesised/composed for this project** (numpy/scipy code in `tools/audio/`) '
             'or a **CC0 (public domain) field recording from Freesound**, listed with links in `fx/audio/CREDITS.md`.\n')
    L.append('## Format and conventions\n')
    L.append('- AAC-LC in `.m4a`, 44.1 kHz (Safari/iOS, Chrome and Firefox decode it). Music mono 64 kb/s, beds stereo '
             '64 kb/s, looped emitters mono 56 kb/s, one-shots mono 48 kb/s.')
    L.append(f"- Total: **{sum(tot.values()) / 1e6:.2f} MB** in {len(meta)} files "
             f"(music {tot['music'] / 1e6:.2f}, beds and crowd {tot['bed'] / 1e6:.2f}, looped emitters "
             f"{tot['emit'] / 1e6:.2f}, one-shots {tot['oneshot'] / 1e6:.2f} MB).")
    L.append('- **Loops.** Every looped file is rendered as an exactly periodic signal (note tails, reverb and filters '
             'wrap around; noise is generated periodically; recordings are cut with a 1.5 s equal-power crossfade into '
             'their own continuation). The file then carries **0.5 s of the loop\'s tail before and 0.5 s of its head '
             'after**; `loop: [0.5, 0.5 + L]` are the loop points in seconds of the decoded file. Because pre- and '
             'post-roll are the loop\'s own audio, any constant AAC priming offset a decoder leaves in (< 0.5 s) only '
             'shifts the window and the loop stays seamless. Loop on the decoded buffer (`loopStart`/`loopEnd`); do not '
             'use `<audio loop>` on these files (the pre/post-roll would be heard).')
    L.append('- **Loudness** (BS.1770 integrated, own meter cross-checked with ffmpeg `ebur128`): music -20 LUFS, beds '
             'and crowd layers -24 LUFS, looped emitters -24 LUFS; loops limited to -3 dBTP before encoding. One-shots '
             'are peak-normalised with relative levels baked in (-3 dBFS bells, fireworks, door phrases; -4 to -8 dBFS '
             'smaller things; footsteps loudness-matched to -27 LUFS, peak <= -3 dBFS; UI click -10 dBFS). The `gain` '
             'fields in `audio.json` set the mix on top; `oneshot_gains` suggests a gain per one-shot name.')
    L.append('- **Music** shares one pitch set (D major / B minor / E dorian = the same seven notes) and tempi of '
             '72, 108 and 144 bpm (or no beat), so neighbouring lands never clash. Most pieces arrange one original '
             'Lanternfall theme (16 bars, D major pentatonic melody) for the land\'s instruments; the wharf plays '
             '"Drunken Sailor" (traditional sea shanty, first printed 1839, public domain) in our own arrangement.')
    L.append('- Positions are in the Blender frame `[x east, y north, z up]`, metres, taken from the baked object '
             'bounding boxes (`tools/audio/objects_dump.py`) and checked with screenshots.\n')
    L.append('## Regenerating\n')
    L.append('```bash\n# Python 3.12 venv with numpy, scipy, soundfile, matplotlib; ffmpeg on PATH\n'
             'python tools/audio/fetch/fs_get.py <user> <id> ...   # CC0 sources (licence verified on the page) -> $AUDIO_SRC\n'
             'python tools/audio/build.py --src $AUDIO_SRC          # render, normalise, encode, write audio.json\n'
             'python tools/audio/analyze.py OUTDIR                  # decode + QA tables, contact sheets, piano rolls\n'
             'python tools/audio/docs.py                            # this README and fx/audio/CREDITS.md\n```\n'
             'The source list with ids and users is `tools/audio/fetch/sources.json`. Renders are deterministic.\n')
    sections = [('bed', 'Ambience beds and crowd layers (stereo)'), ('music', 'Music (mono point sources)'),
                ('emit', 'Looped emitters (mono)'), ('oneshot', 'One-shots (mono)')]
    for cat, title in sections:
        L.append(f'## {title}\n')
        L.append('| file | what / how | sources | s | loop | LUFS | true peak | KB | used by |')
        L.append('|---|---|---|---|---|---|---|---|---|')
        for k, v in sorted(meta.items(), key=lambda kv: kv[1]['file']):
            if v['cat'] != cat:
                continue
            doc = ITEM_DOC.get(k) or GROUP_DOC.get(v.get('group') or '') or (v.get('doc') or '').replace('\n', ' ')
            doc = ' '.join(doc.split())
            lp = f"{v['loop'][0]}-{v['loop'][1]:.3f}" if v['loop'] else '-'
            used = '; '.join(w.get(v['file'], [])) or '(spare)'
            L.append(f"| `{v['file']}` | {doc} | {credit(v.get('sources'))} | {v['seconds']} | {lp} | {v['lufs']} | "
                     f"{v['true_peak']} | {v['bytes'] / 1024:.0f} | {used} |")
        L.append('')
    open(os.path.join(REPO, 'data', 'audio', 'README.md'), 'w').write('\n'.join(L) + '\n')


def credits():
    used = collections.defaultdict(list)
    for k, v in meta.items():
        for s in v.get('sources') or []:
            used[s].append(v['file'])
    L = ['# Lanternfall sound credits\n',
         'All audio in `data/audio/` is one of:\n',
         '1. **Synthesised and composed for this project** by the sound-music agent (Claude), with the numpy/scipy code '
         'in `tools/audio/` (additive, FM, Karplus-Strong and modal synthesis, filtered noise). No samples, sound '
         'fonts or AI audio generators were used for these. All melodies are original except "Drunken Sailor" '
         '(traditional, public domain), newly arranged here. Released with the rest of this repository.',
         '2. **CC0 1.0 (public domain dedication) field recordings from Freesound** (freesound.org), listed below. '
         'For each, the licence was read on the sound\'s own page at download time (`tools/audio/fetch/fs_get.py` '
         'refuses anything that does not link the CC0 1.0 deed) and the HQ preview was used as the source. CC0 needs '
         'no attribution; we credit the recordists anyway. Licence text: `data/audio/LICENSES/CC0-1.0.txt`.\n',
         'Edits applied to every recording: trimming to a steady window, conversion to 44.1 kHz, high/low-pass '
         'filtering, loudness normalisation, a 1.5 s crossfade to make a seamless loop (beds) or onset-based cutting '
         'into single events with fades (one-shots), mixing with synthesised layers, stereo width reduction for mono '
         'compatibility, AAC encoding.\n',
         '## CC0 recordings used\n',
         '| Freesound id | title | recordist | licence | used in |', '|---|---|---|---|---|']
    for sid in sorted(used, key=int):
        r = src[str(sid)]
        files = ', '.join(f'`{f}`' for f in sorted(set(used[sid])))
        L.append(f"| [{sid}]({r['url']}) | {r['title']} | {r['user']} | [{r['licence']}]({r['licence_url']}) | {files} |")
    L.append('\nNote: 483692 ("torch ambience loop" by LordStirling) is itself a loop of FractalStudios\' "Fire Crackle and '
             'Flame 002", which its page states is also released under CC0.\n')
    rest = [k for k in src if int(k) not in used]
    L.append('\n## Evaluated and not used\n')
    L.append('Downloaded (all CC0) and rejected: ' + ', '.join(
        f"[{k}]({src[k]['url']}) ({src[k]['title'][:40]})" for k in sorted(rest, key=int)) + '. Reasons: background '
        'music mentioned in the description (352552, 452458), traffic or highway noise (405318, 718917), close '
        'intelligible speech, noisy phone recordings, or a synthesised version worked better.\n')
    os.makedirs(os.path.join(REPO, 'fx', 'audio'), exist_ok=True)
    open(os.path.join(REPO, 'fx', 'audio', 'CREDITS.md'), 'w').write('\n'.join(L) + '\n')


readme()
credits()
print('wrote README.md and CREDITS.md')
