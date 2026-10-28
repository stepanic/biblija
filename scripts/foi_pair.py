import json, sys, difflib, re
from collections import Counter
d = json.load(open(sys.argv[1]))
def book(ref): return ref.rsplit(' ', 1)[0]
def toks(s): return re.findall(r"\w+|[^\w\s]", s)
foi_by = {}
for ref, t in d['miss_in_ours']: foi_by.setdefault(book(ref), []).append((ref, t))
pairs, unpaired = [], []
for ref, t in d['miss_in_foi']:
    cands = foi_by.get(book(ref), [])
    best = max(cands, key=lambda c: difflib.SequenceMatcher(None, t, c[1], autojunk=False).ratio(), default=None)
    r = difflib.SequenceMatcher(None, t, best[1], autojunk=False).ratio() if best else 0
    if r < 0.5: unpaired.append((ref, t)); continue
    a, b = toks(t), toks(best[1])
    ops = [(tag, ' '.join(a[i1:i2]), ' '.join(b[j1:j2])) for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if tag != 'equal']
    pairs.append((round(r, 3), ref, best[0], ops, t, best[1]))
kinds = Counter()
for r, ref, fref, ops, t, f in pairs:
    for tag, x, y in ops: kinds[(tag, x, y)] += 1
print('sparenih', len(pairs), 'nesparenih', len(unpaired))
print('NAJČEŠĆE RAZLIKE (nas -> FOI):'); [print(f'  {n:4} {k}') for k, n in kinds.most_common(40)]
json.dump({'pairs': pairs, 'unpaired': unpaired}, open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
