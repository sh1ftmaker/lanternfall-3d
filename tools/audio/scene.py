"""Where every sound plays: zones (bed + music + layers), emitters and one-shot lists -> data/audio/audio.json.
Positions are Blender frame [x east, y north, z up] in metres, taken from the baked object bounding boxes
(tools/audio/objects_dump.py over the npz dumps) and the land scripts (parts/*.py via park_common.to_world)."""
import json
import os

# key places (Blender frame). Source object in the comment.
P = {
    'gate_walk': [232.0, 0.0, 4.0],            # Lamplighters' Walk, between the benches (x 188-224) and the arch (259)
    'gate_arch': [259.0, 0.0, 8.0],            # transit_gate_arch
    'spire': [3.5, -0.6, 14.0],                # core_spire (island, lake centre)
    'spire_bell': [3.5, -0.6, 48.0],           # Spire gallery
    'guild_tavern': [-178.5, 0.0, 3.0],        # Tavern Street (house signs x -171..-186, y +-3.5)
    'guild_forge': [-183.0, -44.2, 1.5],       # guildhollow_smithy
    'guild_bell': [-131.2, 10.2, 2.0],         # guildhollow_strength_bell
    'guild_walls': [-203.0, 0.0, 16.0],        # guildhollow_gatehouse (fanfare from the walls)
    'guild_yard': [-182.5, 34.6, 2.0],         # guildhollow_training_yard (yard torches)
    'guild_midway': [-131.0, 0.0, 2.0],        # Guild Fair Midway (stalls x -148..-114)
    'frost_court': [-104.0, 138.0, 4.0],       # between the Crystal Court (-99,146) and the Keep (-143,133)
    'frost_fair': [-155.0, 90.0, 2.0],         # Frost Fair stalls (-137..-170, 75..108)
    'frost_cider': [-120.5, 89.9, 1.5],        # frostmere_cider_stand
    'frost_rink': [-96.8, 62.3, 0.5],          # frostmere_rink
    'meridian_dance': [19.0, 146.2, 2.0],      # meridian_dance_floor (Signal Plaza)
    'meridian_station': [38.0, 114.4, 10.5],   # meridian_platform_n/s (z 10)
    'meridian_sign': [22.5, 157.5, 8.0],       # meridian_sign_signal (neon)
    'wanderers_hall': [178.0, 63.0, 7.0],      # under the dome, in front of the Paper Doors dais (185.6, 66.2)
    'wanderers_fountain': [153.4, 57.1, 1.0],  # forecourt fountain (guests-data POI)
    'brine_tavern': [123.4, -26.4, 2.5],       # brinewatch_tavern_stage (The Brine & Barrel)
    'brine_deck': [129.0, -23.0, 1.0],         # brinewatch_tavern_deck (dice)
    'brine_galleon': [52.7, -18.5, 5.0],       # brinewatch_galleon_hull (ship's bell, creaking)
    'brine_wharf': [108.8, -45.1, 0.5],        # brinewatch_wharf_deck
    'lantern_market': [33.5, -159.1, 3.0],     # lantern_row_market (night market square)
    'lantern_shrine': [60.1, -159.5, 3.0],     # lantern_row_shrine
    'lantern_stage': [28.5, -178.5, 2.5],      # lantern_row_sign_ghost (ghost-story stage)
    'lantern_stalls': [3.6, -161.9, 1.5],      # night market food stalls (guests-data POI)
    'lantern_torii': [39.5, -127.9, 5.0],      # lantern_row_sign_torii (chimes along the approach)
    'rose_band': [-96.9, -62.0, 2.5],          # rosewick_bandstand
    'rose_fountain': [-79.3, -73.5, 1.5],      # rosewick_fountain
    'rose_carousel': [-135.0, -125.2, 3.0],    # rosewick_carousel_pavilion
    'rose_maze': [-150.0, -100.0, 2.0],        # rose beds west of the promenade (nightingale)
}
DOORS = [[181.4, 78.8], [182.9, 77.2], [185.4, 75.1], [186.9, 73.0], [187.9, 71.5], [189.0, 68.7], [189.9, 66.2],
         [190.8, 63.4], [191.1, 60.5], [191.1, 57.9], [190.5, 55.8], [190.2, 53.0]]   # wanderers_doors_paper0..11
GLADES = [[127.2, 118.4], [-46.1, 150.0], [-180.7, 64.5], [-180.7, -64.5], [-46.1, -150.0], [127.2, -118.4]]


def write_json(meta, path):
    def f(name):
        return meta[name]['file'] if name in meta else f'missing/{name}.m4a'

    def lp(name):
        return meta.get(name, {}).get('loop') or [0, 0]

    def bed(name, gain):
        return {'file': f(name), 'gain': gain, 'loop': lp(name)}

    def mus(name, pos, gain, ref, mx):
        return {'file': f(name), 'gain': gain, 'pos': pos, 'ref': ref, 'max': mx, 'loop': lp(name), 'stream': False}

    zones = [
        dict(id='gate', land='gate', bed=bed('bed_gate', .9), music=mus('gate_welcome', P['gate_walk'], .8, 18, 160)),
        dict(id='lake', land='lake', bed=bed('bed_lake', .9), music=mus('lake_hush', P['spire'], .7, 40, 220)),
        dict(id='guildhollow', land='guildhollow', bed=bed('bed_guildhollow', .85),
             music=mus('guild_tavern', P['guild_tavern'], .7, 14, 150)),
        dict(id='frostmere', land='frostmere', bed=bed('bed_frostmere', .9),
             music=mus('frost_court', P['frost_court'], .75, 18, 170)),
        dict(id='meridian', land='meridian', bed=bed('bed_meridian', .7),
             music=mus('meridian_signal', P['meridian_dance'], .65, 16, 170)),
        dict(id='wanderers', land='wanderers', bed=bed('bed_wanderers', .65),
             music=mus('wanderers_hall', P['wanderers_hall'], .6, 20, 160)),
        dict(id='brinewatch', land='brinewatch', bed=bed('bed_brinewatch', .9),
             music=mus('brine_shanty', P['brine_tavern'], .78, 14, 150)),
        dict(id='lantern-row', land='lantern-row', bed=bed('bed_lantern-row', .85),
             music=mus('lantern_market', P['lantern_market'], .8, 16, 160)),
        dict(id='rosewick', land='rosewick', bed=bed('bed_rosewick', .85),
             music=mus('rosewick_waltz', P['rose_band'], .72, 16, 160)),
        dict(id='gap', land='gap', bed=bed('bed_gap', .9)),
        dict(id='sky', land='sky', bed=bed('bed_sky', .9)),
    ]

    def em(id_, name, pos=None, gain=1.0, ref=8, mx=80, loop=True, every=None, **kw):
        e = {'id': id_, 'file': f(name), 'gain': gain, 'ref': ref, 'max': mx}
        if isinstance(pos, str):
            e['follow'] = pos
        else:
            e['pos'] = pos
        if loop:
            e['loop'] = lp(name)
        else:
            e['loop'] = False
        if every:
            e['every'] = every
        e.update(kw)
        return e

    def files(group):
        return sorted(v['file'] for k, v in meta.items() if v.get('group') == group)

    emitters = [
        em('monorail', 'train_loop', 'train', .9, 12, 220, doppler=True),
        em('gate_lamplighter', 'lamplighter_1', [205.0, 0.0, 3.5], .5, 5, 45, loop=False, every=[6, 16],
           files=files('lamplighter'), area={'r': 22}),
        em('carousel_organ', 'carousel_organ', 'carousel', .8, 12, 130),
        em('spire_bell', 'spire_bell_1', P['spire_bell'], 1.0, 60, 600, loop=False, schedule='quarter'),
        em('guild_anvil', 'anvil_1', P['guild_forge'], .7, 6, 70, loop=False, every=[2.5, 8], files=files('anvil')),
        em('guild_strength_bell', 'strength_bell_1', P['guild_bell'], .7, 8, 90, loop=False, every=[14, 40],
           files=files('strength_bell')),
        em('guild_fanfare', 'fanfare_1', P['guild_walls'], .9, 25, 260, loop=False, every=[70, 150]),
        em('guild_torches', 'torch_loop', P['guild_yard'], .6, 4, 35),
        em('frost_drum', 'frost_drum', P['frost_fair'], .55, 10, 110),
        em('frost_kettle', 'kettle_1', P['frost_cider'], .5, 3, 25, loop=False, every=[5, 12], files=files('kettle')),
        em('frost_skates', 'skate_1', P['frost_rink'], .55, 6, 50, loop=False, every=[1.5, 5], files=files('skate'),
           area={'r': 12}),
        em('frost_ice_chimes', 'ice_chimes_1', P['frost_court'], .5, 10, 80, loop=False, every=[5, 14],
           files=files('ice_chimes'), area={'r': 20}),
        em('meridian_chime', 'station_chime_1', P['meridian_station'], .7, 12, 140, loop=False, every=[45, 90]),
        em('meridian_announce', 'announce_1', P['meridian_station'], .5, 10, 100, loop=False, every=[80, 160]),
        em('meridian_neon', 'neon_hum', P['meridian_sign'], .25, 3, 25),
        em('wanderers_fountain', 'fountain_loop', P['wanderers_fountain'], .6, 5, 45),
    ]
    for i, (x, y) in enumerate(DOORS):
        emitters.append(em(f'paper_door_{i + 1:02d}', f'door_{i + 1:02d}', [x, y, 3.0], .6, 8, 70, loop=False,
                           every=[45, 140]))
    emitters += [
        em('brine_ship_bell', 'ship_bell_1', P['brine_galleon'], .7, 15, 180, loop=False, every=[40, 100]),
        em('brine_creak', 'creak_loop', P['brine_galleon'], .6, 6, 50),
        em('brine_creaks', 'creak_1', P['brine_wharf'], .5, 5, 40, loop=False, every=[3, 9], files=files('creak'),
           area={'r': 15}),
        em('brine_dice', 'dice_1', P['brine_deck'], .5, 3, 22, loop=False, every=[6, 16], files=files('dice')),
        em('lantern_shrine_bell', 'shrine_bell_1', P['lantern_shrine'], .7, 12, 150, loop=False, every=[35, 80]),
        em('lantern_clappers', 'clappers_1', P['lantern_stage'], .7, 10, 110, loop=False, every=[40, 90],
           files=files('clappers')),
        em('lantern_taiko', 'taiko_loop', [55.0, -175.0, 3.0], .45, 20, 200),
        em('lantern_sizzle', 'sizzle_loop', P['lantern_stalls'], .5, 3, 25),
        em('lantern_ghost_hush', 'ghost_hush', P['lantern_stage'], .5, 6, 30),
        em('lantern_chimes', 'chimes_loop', P['lantern_torii'], .45, 5, 40),
        em('rose_fountain', 'fountain_loop', P['rose_fountain'], .7, 5, 45),
        em('rose_nightingale', 'nightingale_1', P['rose_maze'], .55, 10, 90, loop=False, every=[3, 11],
           files=files('nightingale'), area={'r': 30}),
        em('punt_oar', 'oar_1', 'punt', .5, 4, 45, loop=False, every=[2.6, 3.4], files=files('oar')),
    ]
    for i, (x, y) in enumerate(GLADES):
        emitters.append(em(f'owl_{i + 1}', 'owl_1', [x * 1.25, y * 1.25, 10.0], .5, 20, 160, loop=False,
                           every=[25, 70], files=files('owl'), area={'r': 40}))

    oneshots = {k: files(k) for k in ['firework_launch', 'firework_burst', 'lantern_release', 'splash',
                                      'footstep_stone', 'footstep_wood', 'footstep_snow', 'footstep_grass', 'footstep_gravel',
                                      'ui_click', 'oar']}
    doc = {
        'version': 1,
        'about': 'Lanternfall soundscape content. See data/audio/README.md. Positions: Blender frame [x, y, z], m.',
        'master': {'gain': 1.0, 'loudness': {'music': -20, 'bed': -24, 'emit': -24, 'oneshot_peak_dbfs': -3}},
        'zones': zones,
        'emitters': emitters,
        'oneshots': oneshots,
        'crowd': [dict(file=f('crowd_sparse'), gain=.8, loop=lp('crowd_sparse'), density=[.05, .35]),
                  dict(file=f('crowd_murmur'), gain=.85, loop=lp('crowd_murmur'), density=[.2, .6]),
                  dict(file=f('crowd_dense'), gain=.8, loop=lp('crowd_dense'), density=[.55, 1.0])],
        'oneshot_gains': {'firework_burst': 1.0, 'firework_launch': .7, 'lantern_release': .6, 'splash': .5,
                          'footstep_stone': .35, 'footstep_wood': .35, 'footstep_snow': .35, 'footstep_grass': .3, 'footstep_gravel': .35,
                          'ui_click': .4, 'oar': .45},
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(doc, fh, indent=1)
    print('wrote', path, len(zones), 'zones', len(emitters), 'emitters')
