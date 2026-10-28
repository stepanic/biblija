"""Usporedba neovisna o numeraciji: tekst retka X traži se u cijeloj knjizi izvora Y."""
import json, re, sys, glob, difflib, unicodedata
R = __import__('os').path.dirname(__import__('os').path.dirname(__import__('os').path.abspath(__file__))) + '/'
tra = sys.argv[1]
def norm(s):
    s = re.sub(r'\([^)]*\d[^)]*\)', ' ', s)
    s = unicodedata.normalize('NFC', s).lower().replace('’', "'")
    s = re.sub(r"[^\w]+", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()
ours = {}   # order -> list of (ref, text), headings separately
heads = {}
for f in sorted(glob.glob(R+'data/json/books/*.json')):
    d = json.load(open(f))
    ours[d['order']] = [(f"{d['abbr']} {c['chapter']},{v['verse']}", v['text']) for c in d['chapters'] for v in c['verses']]
    heads[d['order']] = [h['text'] for c in d['chapters'] for v in c['verses'] for h in v.get('headings', [])]
m = json.load(open(R+f'downloads/cache/foi/{tra}.json'))
bidmap = {x['bid']: i+1 for i, x in enumerate(m['books'])}
foi = {}
for v in m['verses']:
    foi.setdefault(bidmap[v['bid']], []).append((f"{v['ch']},{v['v']}", v['lines']))
miss_in_foi, miss_in_ours = [], []
for o in sorted(ours):
    fb = ' '.join(norm(' '.join(l)) for _, l in foi.get(o, []))
    ob = ' '.join(norm(t) for _, t in ours[o]) + ' ' + ' '.join(norm(h) for h in heads[o])
    for ref, t in ours[o]:
        n = norm(t)
        if n and n not in fb:
            miss_in_foi.append((ref, t))
    for ref, lines in foi.get(o, []):
        for l in lines:
            n = norm(l)
            if n and n not in ob:
                miss_in_ours.append((ours[o][0][0].rsplit(' ',1)[0] + ' ' + ref, l))
print(f'tra={tra}: nasih redaka kojih nema doslovno u FOI: {len(miss_in_foi)}; FOI redaka kojih nema kod nas: {len(miss_in_ours)}')
json.dump({'miss_in_foi': miss_in_foi, 'miss_in_ours': miss_in_ours}, open(f'diff_{tra}.json','w'), ensure_ascii=False, indent=0)
