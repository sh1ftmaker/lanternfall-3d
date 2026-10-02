"""Search Freesound (website, no API key) for CC0 sounds and list candidates.
usage: python fs_search.py "query words" [page]
Prints: id  duration  downloads  user  title  licence
The CC0 filter is applied in the query; licence is re-read from each result block."""
import re, sys, urllib.parse, urllib.request
q = sys.argv[1]; page = sys.argv[2] if len(sys.argv) > 2 else '1'
url = ('https://freesound.org/search/?q=' + urllib.parse.quote_plus(q) +
       '&f=license%3A%22Creative+Commons+0%22&page=' + page)
h = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})).read().decode()
blocks = h.split('class="bw-search__result"')[1:]
for b in blocks:
    g = lambda k: (re.search(k + r'="([^"]*)"', b) or [None, ''])[1]
    lic = (re.search(r'title="License: ([^"]+)"', b) or [None, '?'])[1]
    print(f"{g('data-sound-id'):>8} {float(g('data-duration') or 0):7.1f}s {g('data-num-downloads'):>6} "
          f"{g('data-username'):<20} {g('data-title')[:60]:<60} {lic}")
