"""Fetch a CC0 Freesound sound: verify the licence on its page, save the HQ preview and record provenance.
usage: python fs_get.py <user> <id> [<user> <id> ...]
Writes <SRC>/fs<id>.mp3 (SRC = env AUDIO_SRC, default ./src) and merges an entry into sources.json next to this
script: {id: {url, user, title, licence, licence_url, description, tags, preview, duration}}.
Refuses (and records nothing) unless the page links the CC0 1.0 deed."""
import json, os, re, sys, html, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get('AUDIO_SRC', 'src'); os.makedirs(SRC, exist_ok=True)
REG = os.path.join(HERE, 'sources.json')
reg = json.load(open(REG)) if os.path.exists(REG) else {}
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})).read()
a = sys.argv[1:]
for user, sid in zip(a[0::2], a[1::2]):
    url = f'https://freesound.org/people/{user}/sounds/{sid}/'
    h = get(url).decode()
    lic = re.search(r'title="Go to the full license text" href="([^"]+)"[^>]*>([^<]+)<', h)
    if not lic or 'publicdomain/zero/1.0' not in lic.group(1):
        print('REFUSED (not CC0):', url, lic and lic.groups()); continue
    title = html.unescape(re.search(r'og:audio:title" content="([^"]*)"', h).group(1))
    m = re.search(r'id="soundDescriptionSection">(.*?)</div>', h, re.S)
    desc = html.unescape(re.sub(r'<[^>]+>', ' ', m.group(1))).strip() if m else ''
    desc = re.sub(r'\s+', ' ', desc)[:600]
    tags = sorted(set(re.findall(r'href="/browse/tags/([^/"]+)/', h)))
    prev = re.search(r'(https://cdn\.freesound\.org/previews/\d+/\d+_\d+)-lq\.mp3', h).group(1) + '-hq.mp3'
    out = os.path.join(SRC, f'fs{sid}.mp3')
    if not os.path.exists(out):
        open(out, 'wb').write(get(prev))
    dur = re.search(r'data-duration="([\d.]+)"', h)
    reg[sid] = dict(url=url, user=user, title=title, licence=lic.group(2).strip(), licence_url=lic.group(1),
                    description=desc, tags=tags[:20], preview=prev, duration=float(dur.group(1)) if dur else None)
    print('OK', sid, user, title, '|', desc[:150])
json.dump(reg, open(REG, 'w'), indent=1, sort_keys=True)
