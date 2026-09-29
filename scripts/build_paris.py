#!/usr/bin/env python3
"""Builds data/paris.json: Paris Métro lines 1-14 (incl. 3bis, 7bis) with depth.

Sources:
  - Wikidata: stations, coordinates, labels, photos, and "adjacent station" (P197)
    qualified by line, which gives station order and branches
  - French Wikipedia station infoboxes: position (underground / elevated / ground)
    and opening date
  - Platform depths quoted in French Wikipedia articles (DEPTHS below)

Paris does not publish per-station depths. Stations without a quoted figure get a
typical value for their line and are flagged as estimates.

Lines 15-18 (Grand Paris Express) are not open yet and are left out.
Usage: python3 scripts/build_paris.py
"""
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request

from build_moscow import attach_photos, fetch, km_between

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
UA = {"User-Agent": "moscow-metro-3d/0.1 (personal visualisation)"}
TODAY = time.strftime("%Y-%m-%d")

# Wikidata line item -> (number shown on the badge, sort order)
LINES = {
    "Q13224": "1", "Q50718": "2", "Q50741": "3", "Q50742": "3bis", "Q50743": "4", "Q50745": "5",
    "Q50746": "6", "Q50748": "7", "Q50749": "7bis", "Q50751": "8", "Q50753": "9", "Q50754": "10",
    "Q50756": "11", "Q50757": "12", "Q50759": "13", "Q50761": "14",
}

SPARQL = """
SELECT ?line ?color ?s ?fr ?ru ?coord ?image ?adj ?closed ?frwiki ?ruwiki WHERE {
  VALUES ?line { %s }
  ?s p:P81 ?ls . ?ls ps:P81 ?line .
  ?s wdt:P625 ?coord .
  OPTIONAL { ?line wdt:P465 ?color }
  OPTIONAL { ?s rdfs:label ?fr FILTER(lang(?fr)="fr") }
  OPTIONAL { ?s rdfs:label ?ru FILTER(lang(?ru)="ru") }
  OPTIONAL { ?s wdt:P18 ?image }
  OPTIONAL { ?s p:P197 ?as . ?as ps:P197 ?adj ; pq:P81 ?line . }
  OPTIONAL { { ?s wdt:P576 ?closed } UNION { ?s wdt:P3999 ?closed } }
  OPTIONAL { ?frwiki schema:about ?s ; schema:isPartOf <https://fr.wikipedia.org/> }
  OPTIONAL { ?ruwiki schema:about ?s ; schema:isPartOf <https://ru.wikipedia.org/> }
}""" % " ".join("wd:" + q for q in LINES)

# Platform depths (m) quoted in the station's French Wikipedia article, per line.
DEPTHS = {
    ("12", "Abbesses"): 36, ("4", "Barbara"): 25, ("4", "Cité"): 25, ("12", "Front populaire"): 20,
    ("12", "Lamarck - Caulaincourt"): 25, ("14", "Mairie de Saint-Ouen"): 21, ("7", "Maison Blanche"): 14,
    ("14", "Maison Blanche"): 21, ("11", "Place des Fêtes"): 27, ("14", "Pont Cardinet"): 20,
    ("14", "Porte de Clichy"): 26, ("11", "Romainville - Carnot"): 26, ("14", "Saint-Denis Pleyel"): 27,
    ("14", "Saint-Ouen"): 18.3, ("11", "Serge Gainsbourg"): 20, ("14", "Thiais - Orly"): 26,
    ("14", "Villejuif - Gustave Roussy"): 36.7,
}
# Typical depth for an underground station, by line (used when no figure is quoted).
# The classic network is cut-and-cover just under the street; newer lines and extensions are bored deeper.
DEFAULT_DEPTH = {"14": 22}
DEEP_EXTENSIONS = {  # stations on recent deep extensions
    "4": {"Mairie de Montrouge", "Bagneux - Lucie Aubrac"},
    "11": {"Montreuil - Hôpital", "La Dhuys", "Coteaux Beauclair", "Rosny - Bois-Perrier"},
    "12": {"Aimé Césaire", "Mairie d'Aubervilliers"},
}
# Ghost stations (closed in 1939 or never opened). Their infoboxes don't always say so.
# Stations Wikidata attaches to a line only through planned extensions.
NOT_ON_LINE = {("10", "Bibliothèque François-Mitterrand"), ("10", "Chevaleret")}
GHOSTS = {"Arsenal", "Champ de Mars", "Croix-Rouge", "Saint-Martin", "Haxo", "Porte Molitor", "Martin Nadaud"}
SHALLOW = 7
ELEVATED = -7  # typical viaduct height above the street

# Known opening dates of line 14 platforms at transfer stations (the line opened in stages).
LINE_OPEN = {("14", n): "1998-10-15" for n in ("Madeleine", "Pyramides", "Châtelet", "Gare de Lyon", "Bercy")}
LINE_OPEN.update({("14", "Saint-Lazare"): "2003-12-16", ("14", "Olympiades"): "2007-06-26",
                  ("14", "Mairie de Saint-Ouen"): "2020-12-14", ("14", "Maison Blanche"): "2024-06-24"})

MONTHS = {m: i + 1 for i, m in enumerate(
    "janvier février mars avril mai juin juillet août septembre octobre novembre décembre".split())}

MILESTONES = [
    [1900.55, "Line 1 opens for the World's Fair: Porte de Vincennes to Porte Maillot",
     "Открыта первая линия к Всемирной выставке: от Порт-де-Венсен до Порт-Майо"],
    [1906.31, "Line 2 Sud crosses the Seine on the Passy viaduct, next to the Eiffel Tower",
     "Метро пересекает Сену по виадуку Пасси, рядом с Эйфелевой башней"],
    [1910.84, "The rival Nord-Sud company opens its first line (today's line 12)",
     "Конкурирующая компания «Nord-Sud» открывает свою линию (сейчас линия 12)"],
    [1913.08, "Abbesses opens under Montmartre: 36 m, deepest in Paris for a century",
     "Открыта «Аббесс» под Монмартром: 36 м, самая глубокая станция Парижа на целый век"],
    [1998.79, "Line 14 opens: the first fully automatic line in Paris",
     "Открыта линия 14: первая полностью автоматическая линия Парижа"],
    [2024.48, "Line 14 reaches Saint-Denis and Orly airport, just before the Olympics",
     "Линия 14 дотянулась до Сен-Дени и аэропорта Орли, прямо перед Олимпиадой"],
]


def norm(s):
    return (s or "").strip()


def parse_infobox(wt):
    """Return (position, opening date ISO, closed?) from a French station infobox."""
    pos = re.search(r"\|\s*position\s*=\s*([^\n|]*)", wt)
    pos = re.sub(r"[\[\]]", "", pos.group(1)).strip().lower() if pos else ""
    m = re.search(r"\|\s*mise en service\s*=\s*([^\n]*)", wt)
    opened = None
    if m:
        txt = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", m.group(1))  # [[target|text]] -> text
        txt = txt.replace("{{1er}}", "1").replace("{{er}}", "")
        txt = re.sub(r"[{}|\[\]]", " ", txt)
        d = re.search(r"\b(\d{1,2})(?:er)?\s+(" + "|".join(MONTHS) + r")\s+(\d{4})", txt)
        if d:
            opened = "%s-%02d-%02d" % (d.group(3), MONTHS[d.group(2)], int(d.group(1)))
        else:
            y = re.search(r"\b(1[89]\d\d|20\d\d)\b", txt)
            opened = y and y.group(1) + "-01-01"
    closed = re.search(r"\|\s*fermeture\s*=\s*([^\n|]*)", wt)
    return pos, opened, bool(closed and re.search(r"\d{4}", closed.group(1)))


def fetch_frwiki(titles):
    path = os.path.join(CACHE, "paris_frwiki.json")
    if os.path.exists(path):
        return json.load(open(path))
    out = {}
    for i in range(0, len(titles), 40):
        q = urllib.parse.urlencode({"action": "query", "format": "json", "prop": "revisions", "rvprop": "content",
                                    "rvslots": "main", "redirects": 1, "titles": "|".join(titles[i:i + 40])})
        body = json.load(urllib.request.urlopen(urllib.request.Request(
            "https://fr.wikipedia.org/w/api.php?" + q, headers=UA), timeout=90))
        redir = {r["to"]: r["from"] for r in body["query"].get("redirects", [])}
        for p in body["query"]["pages"].values():
            if "revisions" in p:
                out[redir.get(p["title"], p["title"])] = p["revisions"][0]["slots"]["main"]["*"]
        time.sleep(1)
    json.dump(out, open(path, "w"), ensure_ascii=False)
    return out


def split_paths(nodes, adj):
    """Decompose a line's station graph into paths between termini / branch points."""
    special = {n for n in nodes if len(adj[n]) != 2}
    used, paths = set(), []

    def walk(a, b):
        path = [a, b]
        while path[-1] not in special:
            nxt = [x for x in adj[path[-1]] if x != path[-2]]
            if not nxt or nxt[0] == path[0] and len(path) > 2:
                if nxt:
                    path.append(nxt[0])
                break
            path.append(nxt[0])
        return path

    for s in sorted(special) or sorted(nodes)[:1]:
        for n in sorted(adj[s]):
            e = frozenset((s, n))
            if e in used:
                continue
            p = walk(s, n)
            used.update(frozenset(x) for x in zip(p, p[1:]))
            paths.append(p)
    # Join two paths through a branch point when they continue each other, so the
    # main line is one smooth tube.
    joined = True
    while joined:
        joined = False
        for i, a in enumerate(paths):
            for j, b in enumerate(paths):
                if i >= j:
                    continue
                for pa, pb in ((a, b), (a[::-1], b), (a, b[::-1]), (a[::-1], b[::-1])):
                    end = pa[-1]
                    if end == pb[0] and len(adj[end]) == 3 and pa[0] != pb[-1]:
                        others = [p for k, p in enumerate(paths) if k not in (i, j) and end in (p[0], p[-1])]
                        if others:  # only join if a third path stays at this branch
                            paths[i] = pa + pb[1:]
                            del paths[j]
                            joined = True
                            break
                if joined:
                    break
            if joined:
                break
    return paths


def main():
    b = fetch("paris_wikidata.json", "https://query.wikidata.org/sparql",
              urllib.parse.urlencode({"query": SPARQL}).encode())["results"]["bindings"]
    titles = sorted({urllib.parse.unquote(r["frwiki"]["value"].split("/wiki/")[-1]).replace("_", " ")
                     for r in b if "frwiki" in r})
    wiki = fetch_frwiki(titles)

    ents, lines = {}, {}
    for r in b:
        q = r["s"]["value"].rsplit("/", 1)[-1]
        lq = r["line"]["value"].rsplit("/", 1)[-1]
        lines.setdefault(lq, {"color": r.get("color", {}).get("value"), "stations": set(), "adj": {}})
        e = ents.setdefault(q, {"fr": norm(r.get("fr", {}).get("value")), "ru": norm(r.get("ru", {}).get("value")),
                                "closed": False, "image": None, "wiki": None})
        lng, lat = map(float, r["coord"]["value"][6:-1].split())
        e["lat"], e["lng"] = lat, lng
        if "image" in r and not e["image"]:
            e["image"] = urllib.parse.unquote(r["image"]["value"].rsplit("/", 1)[-1])
        if "ruwiki" in r:  # ru.wikipedia titles are better Russian names than Wikidata labels
            t = urllib.parse.unquote(r["ruwiki"]["value"].split("/wiki/")[-1]).replace("_", " ")
            e["ru"] = re.sub(r"\s*\(.*\)$", "", t)
        if "frwiki" in r:
            e["wiki"] = urllib.parse.unquote(r["frwiki"]["value"].split("/wiki/")[-1]).replace("_", " ")
        lines[lq]["stations"].add(q)
        if "adj" in r:
            lines[lq]["adj"].setdefault(q, set()).add(r["adj"]["value"].rsplit("/", 1)[-1])

    for e in ents.values():
        e["position"], e["open"], e["closed"] = parse_infobox(wiki.get(e["wiki"] or "", ""))

    def alive(q):
        e = ents[q]
        return not e["closed"] and e["fr"] not in GHOSTS and e["open"] and e["open"] <= TODAY

    out_lines, stations = [], []
    order = list(LINES)
    for lq in sorted(lines, key=order.index):
        num = LINES[lq]
        L = lines[lq]
        nodes = {q for q in L["stations"] if alive(q) and (num, ents[q]["fr"]) not in NOT_ON_LINE}
        adj = {q: {a for a in L["adj"].get(q, ()) if a in nodes} for q in nodes}
        for q in nodes:  # adjacency is not always stated in both directions
            for a in adj[q]:
                adj[a].add(q)
        nodes = {q for q in nodes if adj[q]}
        paths = split_paths(nodes, adj)

        # Opening date on this line. Transfer stations carry the date of their first line, so
        # walk along this line in each direction to the nearest single-line station: the
        # platform opened when the earlier of those two sides reached it.
        multi = {q for q in nodes if sum(q in l["stations"] and alive(q) for l in lines.values()) > 1}

        def side_date(frm, to):
            seen = {frm}
            while to in multi:
                seen.add(to)
                nxt = [x for x in adj[to] if x not in seen]
                if not nxt:
                    return None  # reached a terminus that is itself a transfer station
                to = nxt[0]
            return ents[to]["open"]

        opened = {}
        for q in nodes:
            if (num, ents[q]["fr"]) in LINE_OPEN:
                opened[q] = LINE_OPEN[(num, ents[q]["fr"])]
            elif q in multi:
                sides = [d for d in (side_date(q, a) for a in adj[q]) if d]
                opened[q] = max(ents[q]["open"], min(sides)) if sides else ents[q]["open"]
            else:
                opened[q] = ents[q]["open"]

        sid = lambda q: f"{num}.{q}"
        for q in sorted(nodes):
            e = ents[q]
            pos = e["position"]
            if (num, e["fr"]) in DEPTHS:
                depth, src = DEPTHS[(num, e["fr"])], "fr.wikipedia"
            elif "aérien" in pos:
                depth, src = ELEVATED, "estimate"
            elif "sol" in pos or "surface" in pos:
                depth, src = 0, "fr.wikipedia"
            elif "semi" in pos or "tranchée" in pos:
                depth, src = 3, "estimate"
            elif e["fr"] in DEEP_EXTENSIONS.get(num, ()):
                depth, src = 20, "estimate"
            else:
                depth, src = DEFAULT_DEPTH.get(num, SHALLOW), "estimate"
            stations.append({
                "id": sid(q), "line": num, "name": e["ru"] or e["fr"], "nameEn": e["fr"],
                "lat": round(e["lat"], 6), "lng": round(e["lng"], 6),
                "depth": depth, "source": src, "open": opened[q], "image": e["image"],
            })
        main_path = max(paths, key=len)
        c = "#" + (L["color"] or "888888")
        out_lines.append({
            "id": num, "num": num, "name": f"Линия {num.replace('bis', 'бис')}", "nameEn": f"Line {num}",
            "sub": f"{ents[main_path[0]]['fr']} – {ents[main_path[-1]]['fr']}",
            "color": c, "ring": False, "segments": [[sid(q) for q in p] for p in paths],
        })

    attach_photos(stations, "paris_commons")
    transfers = []
    for i, a in enumerate(stations):
        for s2 in stations[i + 1:]:
            if a["line"] != s2["line"] and km_between(a, s2) < 0.25:
                transfers.append([a["id"], s2["id"]])

    city = {
        "id": "paris", "name": {"en": "Paris", "ru": "Париж"},
        "title": {"en": "Paris Métro, underground", "ru": "Парижское метро под землёй"},
        "docTitle": {"en": "Paris Métro Depths", "ru": "Глубина парижского метро"},
        "center": [48.8566, 2.3522], "exag": 90, "firstYear": 1900, "milestones": MILESTONES,
        "note": {
            "en": "Paris publishes few station depths. Most stations sit about 5-8 m under the street; "
                  "values without a quoted figure are estimates.",
            "ru": "В Париже глубину станций почти не публикуют. Большинство станций лежит в 5-8 м под улицей; "
                  "где нет точной цифры, глубина приблизительная.",
        },
    }
    out = {"generated": TODAY, "city": city, "lines": out_lines, "stations": stations, "transfers": transfers}
    path = os.path.join(ROOT, "data", "paris.json")
    json.dump(out, open(path, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out_lines)} lines, {len(stations)} stations, {len(transfers)} transfers -> {path}")
    for l in out_lines:
        print(f"  {l['num']:>4} {l['sub'][:50]:50} segments={[len(s) for s in l['segments']]}")
    print("published depths:", sum(s["source"] != "estimate" for s in stations),
          "estimates:", sum(s["source"] == "estimate" for s in stations))


if __name__ == "__main__":
    main()
