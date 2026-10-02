import sys,json,re
txt=sys.stdin.read(); i=txt.find('{'); j=txt.rfind('}')
try: d=json.loads(txt[i:j+1])
except Exception: print(txt[-3000:]); sys.exit()
acts={}
for l in open('/home/zalo/Work/nocturne-lands/_wt/platformer/fx/platformer/actions.js'):
  m=re.match(r"\s*0x([0-9A-F]+): '(.*)',",l)
  if m: acts[int(m.group(1),16)]=m.group(2)
for k,w in d.items():
  if w.get('empty'): print(k,'EMPTY'); continue
  print(k, {x:w[x] for x in ('peakAbove','drop','maxSpeed','dist','start','end','surfaces')}, w.get('info') if isinstance(w.get('info'),dict) else '')
  print('    ', ' > '.join(f"{a}:{acts.get(x,hex(x))}" for a,x in zip(w['actTimes'],w['acts']))[:700])
print(txt[j+1:][:1500])
