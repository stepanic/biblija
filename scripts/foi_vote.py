"""Tri izvora: naša baza (biblija.ks.hr) vs FOI KS vs hrv_usfm (eBible). Tko je u manjini?"""
import json, re, glob, sys, unicodedata
R = __import__('os').path.dirname(__import__('os').path.dirname(__import__('os').path.abspath(__file__))) + '/'
U = '/Users/ms/git/domovinatv/biblija/.cache/saric/usfm/'
def norm(s):
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')      # bez naglasaka
    s = s.lower().replace('’', "'")
    s = re.sub(r"[^\w]+", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()
abbr2usfm = {b['abbr']: b['usfm_id'] for b in json.load(open(R+'data/json/books.json'))}
usfm = {}
for f in glob.glob(U+'*.usfm'):
    code = re.search(r'\d+-(\w{3})hrv', f).group(1)
    t = open(f, encoding='utf-8').read()
    t = re.sub(r'\\f .*?\\f\*|\\x .*?\\x\*', ' ', t, flags=re.S)
    t = re.sub(r'\\[a-z0-9]+\*?', ' ', t)
    usfm[code] = norm(t)
P = json.load(open(sys.argv[1]))
res = {'nas_pogresan': [], 'foi_pogresan': [], 'neodluceno': []}
for r, ref, fref, ops, ours, foi in P['pairs']:
    if any('?' in y for _, _, y in ops):
        if all('?' in y for _, _, y in ops): continue           # samo pokvareni naglasci u FOI
    a, b = norm(ours), norm(foi)
    if a == b: continue                                        # razlika samo u naglascima/interpunkciji
    u = usfm.get(abbr2usfm[ref.rsplit(' ', 1)[0]], '')
    ina, inb = a in u, b in u
    key = 'foi_pogresan' if ina and not inb else 'nas_pogresan' if inb and not ina else 'neodluceno'
    res[key].append({'ref': ref, 'foi_ref': fref, 'ops': ops, 'nas': ours, 'foi': foi})
for k, v in res.items(): print(k, len(v))
print('\n== NAŠ U MANJINI (FOI + usfm se slažu) ==')
for x in res['nas_pogresan']: print(f"{x['ref']}: {[(o[1], o[2]) for o in x['ops']]}")
json.dump(res, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
