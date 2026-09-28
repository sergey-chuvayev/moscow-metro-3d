#!/usr/bin/env python3
"""Builds data/metro.json: Moscow metro lines + stations with depth.

Sources:
  - hh.ru metro API (station list, coordinates, line colours, order)
  - Wikidata P4511 "vertical depth" (station depth in metres)
  - Russian Wikipedia infoboxes + manual estimates for stations Wikidata lacks
    (see OVERRIDES; every value carries its source so the UI can flag estimates)

Usage: python3 scripts/build_data.py
"""
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
UA = {"User-Agent": "moscow-metro-3d/0.1 (personal visualisation)"}

SPARQL = """
SELECT ?s ?ru ?en ?coord ?depth ?open ?image ?lineLabel ?lineStart WHERE {
  ?s wdt:P31/wdt:P279* wd:Q928830 ; wdt:P16 wd:Q5499 .
  OPTIONAL { ?s rdfs:label ?ru FILTER(lang(?ru)="ru") }
  OPTIONAL { ?s rdfs:label ?en FILTER(lang(?en)="en") }
  OPTIONAL { ?s wdt:P625 ?coord }
  OPTIONAL { ?s wdt:P4511 ?depth }
  OPTIONAL { ?s wdt:P1619 ?open }
  OPTIONAL { ?s wdt:P18 ?image }
  OPTIONAL { ?s p:P81 ?ls . ?ls ps:P81 ?line . ?line rdfs:label ?lineLabel FILTER(lang(?lineLabel)="ru")
             OPTIONAL { ?ls pq:P580 ?lineStart } }
}"""

# hh line id -> (English name, Wikidata line labels that count as "same line")
LINES = {
    "1": ("Sokolnicheskaya", ["Сокольническая"]),
    "2": ("Zamoskvoretskaya", ["Замоскворецкая"]),
    "3": ("Arbatsko-Pokrovskaya", ["Арбатско-Покровская"]),
    "4": ("Filyovskaya", ["Филевская"]),
    "5": ("Koltsevaya (Circle)", ["Кольцевая линия"]),
    "6": ("Kaluzhsko-Rizhskaya", ["Калужско-Рижская"]),
    "7": ("Tagansko-Krasnopresnenskaya", ["Таганско-Краснопресненская"]),
    "8": ("Kalininskaya", ["Калининская", "Калининско-Солнцевская"]),
    "9": ("Serpukhovsko-Timiryazevskaya", ["Серпуховско-Тимирязевская"]),
    "10": ("Lyublinsko-Dmitrovskaya", ["Люблинско-Дмитровская"]),
    "12": ("Butovskaya", ["Бутовская"]),
    "133": ("Solntsevskaya", ["Солнцевская", "Калининско-Солнцевская"]),
    "95": ("MCC (Central Circle)", ["Московская кольцевая"]),
    "97": ("Big Circle Line", ["Большая кольцевая", "Каховская"]),
    "98": ("Nekrasovskaya", ["Некрасовская", "Большая кольцевая"]),
    "137": ("Troitskaya", ["Троицкая"]),
    "171": ("Rublyovo-Arkhangelskaya", ["Рублёво-Архангельская", "Рублево-Архангельская"]),
}
RINGS = {"5", "95", "97"}

# Station order fixes where the hh.ru "order" field is wrong or the line branches.
SEQUENCES = {
    "4": [
        ["Кунцевская", "Пионерская", "Филевский парк", "Багратионовская", "Фили", "Кутузовская",
         "Студенческая", "Киевская", "Смоленская", "Арбатская", "Александровский сад"],
        ["Киевская", "Деловой центр (Выставочная)", "Москва-Сити"],
    ],
    "133": [["Деловой центр", "Парк Победы", "Минская", "Ломоносовский проспект", "Раменки",
             "Мичуринский проспект", "Озёрная", "Говорово", "Солнцево", "Боровское шоссе",
             "Новопеределкино", "Рассказовка", "Пыхтино", "Аэропорт Внуково"]],
    "98": [["Электрозаводская", "Лефортово", "Авиамоторная", "Нижегородская",
            "Стахановская", "Окская", "Юго-Восточная", "Косино", "Улица Дмитриевского",
            "Лухмановская", "Некрасовка"]],
}

# (line id, station name) -> (depth m, source). Negative = above ground (bridge).
W, E = "ru.wikipedia", "estimate"
OVERRIDES = {
    ("8", "Третьяковская"): (46, W), ("6", "Третьяковская"): (46, W),
    ("1", "Библиотека им.Ленина"): (12, W), ("1", "Воробьевы горы"): (-8, "bridge"),
    ("1", "Юго-Западная"): (8, W), ("1", "Филатов луг"): (0, W), ("1", "Прокшино"): (0, W),
    ("1", "Ольховая"): (12, W), ("1", "Новомосковская (Коммунарка)"): (18, E),
    ("2", "Технопарк"): (0, W),
    ("3", "Кунцевская"): (0, W),
    ("4", "Кунцевская"): (0, W), ("4", "Пионерская"): (0, W), ("4", "Филевский парк"): (0, W),
    ("4", "Багратионовская"): (0, W), ("4", "Фили"): (0, W), ("4", "Кутузовская"): (0, W),
    ("4", "Студенческая"): (0, W), ("4", "Деловой центр (Выставочная)"): (22.5, "wikidata"),
    ("7", "Выхино"): (0, W),
    ("10", "Физтех"): (12, E), ("10", "Лианозово"): (12, E), ("10", "Яхромская"): (15, E),
    ("10", "Окружная"): (12, E), ("10", "Люблино"): (8, W),
    ("133", "Пыхтино"): (0, W), ("133", "Парк Победы"): (73, E), ("133", "Аэропорт Внуково"): (15, E),
    ("97", "Проспект Вернадского"): (16, W), ("97", "Зюзино"): (17.5, W),
    ("97", "Нагатинский Затон"): (27, W), ("97", "Печатники"): (30, W),
    ("97", "Лефортово"): (16.6, W), ("97", "Народное Ополчение"): (20, E),
    ("97", "Терехово"): (22.5, W), ("97", "Кунцевская"): (37.6, W), ("97", "Аминьевская"): (14, W),
    ("97", "Рижская"): (63.5, W), ("97", "Савёловская"): (63, W),
    ("98", "Лефортово"): (16.6, W),
    ("133", "Мичуринский проспект"): (19, "wikidata (BKL platform)"), ("137", "Новаторская"): (11, "wikidata (BKL platform)"),
    ("137", "ЗИЛ"): (12, E), ("137", "Крымская"): (22, W), ("137", "Академическая"): (25, E),
    ("137", "Вавиловская"): (25, E), ("137", "Университет дружбы народов"): (15, E),
    ("137", "Генерала Тюленева"): (15, E), ("137", "Коммунарка"): (15, E),
    ("137", "Новомосковская"): (18, E),
    ("171", "Звенигородская"): (20, E), ("171", "Бульвар Генерала Карбышева"): (20, E),
}
# (line id, station name) -> opening date, where one Wikidata item covers several lines
# that opened at different times.
OPEN_OVERRIDES = {
    ("1", "Библиотека им.Ленина"): "1935-05-15", ("97", "Каховская"): "1969-08-11",
    ("6", "Третьяковская"): "1971-01-03", ("8", "Третьяковская"): "1986-01-30",
    ("133", "Парк Победы"): "2014-01-31", ("10", "Петровско-Разумовская"): "2016-09-16",
    ("98", "Лефортово"): "2023-03-01", ("98", "Электрозаводская"): "2023-03-01",
    ("97", "Лефортово"): "2023-03-01", ("97", "Электрозаводская"): "2023-03-01",
}
MCC_OPEN = "2016-09-10"

COORD_FIX = {("10", "Лианозово"): (55.89807, 37.54463)}  # hh.ru has it ~3.7 km off


def fetch(name, url, data=None):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path):
        return json.load(open(path))
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, "Accept": "application/sparql-results+json"})
            body = json.load(urllib.request.urlopen(req, timeout=120))
            json.dump(body, open(path, "w"), ensure_ascii=False)
            return body
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    raise RuntimeError("rate limited: " + url)


def norm(s):
    return (s or "").lower().replace("ё", "е").replace("«", "").replace("»", "").strip()


def km(lat1, lng1, lat2, lng2):
    return math.hypot((lat1 - lat2) * 111.2, (lng1 - lng2) * 111.2 * math.cos(math.radians(55.75)))


def attach_photos(stations):
    """Resolve Wikidata P18 file names to Commons thumbnails with author and licence."""
    files = sorted({s["image"] for s in stations if s["image"]})
    info = {}
    for i in range(0, len(files), 40):
        chunk = files[i:i + 40]
        q = urllib.parse.urlencode({
            "action": "query", "format": "json", "prop": "imageinfo", "iiprop": "url|extmetadata",
            "iiurlwidth": 640, "iiextmetadatafilter": "Artist|LicenseShortName",
            "titles": "|".join("File:" + f for f in chunk),
        })
        body = fetch(f"commons_{i}.json", "https://commons.wikimedia.org/w/api.php?" + q)
        norm_map = {n["to"]: n["from"] for n in body["query"].get("normalized", [])}
        for page in body["query"]["pages"].values():
            if "imageinfo" not in page:
                continue
            ii = page["imageinfo"][0]
            meta = ii.get("extmetadata", {})
            artist = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", "")).strip()
            title = norm_map.get(page["title"], page["title"])
            info[title[5:]] = {
                "src": ii["thumburl"].split("?")[0], "page": ii["descriptionurl"],
                "author": re.sub(r"\s+", " ", artist)[:80],
                "license": meta.get("LicenseShortName", {}).get("value", ""),
            }
    for s in stations:
        f = s.pop("image")
        key = f and (f if f in info else f.replace("_", " "))
        s["photo"] = info.get(key) if key else None
    print("photos:", sum(1 for s in stations if s["photo"]), "of", len(stations))


def main():
    hh = fetch("hh.json", "https://api.hh.ru/metro/1")
    wd = fetch("wikidata.json", "https://query.wikidata.org/sparql",
               urllib.parse.urlencode({"query": SPARQL}).encode())["results"]["bindings"]

    ents = {}
    for b in wd:
        e = ents.setdefault(b["s"]["value"], {"ru": b.get("ru", {}).get("value"), "en": b.get("en", {}).get("value"),
                                               "depth": None, "lines": set(), "coord": None,
                                               "open": None, "image": None, "lineStart": {}})
        if "depth" in b:
            e["depth"] = float(b["depth"]["value"])
        if "lineLabel" in b:
            e["lines"].add(norm(b["lineLabel"]["value"]))
            if "lineStart" in b:
                e["lineStart"][norm(b["lineLabel"]["value"])] = b["lineStart"]["value"][:10]
        if "open" in b:
            d = b["open"]["value"][:10]
            e["open"] = min(e["open"] or d, d)
        if "image" in b and not e["image"]:
            e["image"] = urllib.parse.unquote(b["image"]["value"].rsplit("/", 1)[-1])
        if "coord" in b:
            lng, lat = map(float, b["coord"]["value"][6:-1].split())
            e["coord"] = (lat, lng)

    def match(line_id, st):
        aliases = [norm(a) for a in LINES[line_id][1]]
        base = norm(st["name"]).split(" (")[0]
        cands = []
        for e in ents.values():
            n = norm(e["ru"])
            if n != norm(st["name"]) and n != base and not n.startswith(base + " ("):
                continue
            d = km(st["lat"], st["lng"], *e["coord"]) if e["coord"] else 99
            if d > 1.5:
                continue
            on_line = any(a in l for a in aliases for l in e["lines"])
            cands.append((not on_line, d, e))
        cands.sort(key=lambda c: (c[0], c[1]))
        return cands[0][2] if cands else None

    stations, lines, missing = [], [], []
    for L in hh["lines"]:
        lid = L["id"]
        if lid not in LINES:
            continue
        by_name = {}
        for st in sorted(L["stations"], key=lambda s: s["order"]):
            lat, lng = COORD_FIX.get((lid, st["name"]), (st["lat"], st["lng"]))
            st = {**st, "lat": lat, "lng": lng}
            e = match(lid, st)
            if (lid, st["name"]) in OVERRIDES:
                depth, src = OVERRIDES[(lid, st["name"])]
            elif lid == "95":
                depth, src = 0, "surface railway"
            elif e and e["depth"] is not None:
                depth, src = e["depth"], "wikidata"
            else:
                depth, src = None, None
                missing.append((L["name"], st["name"]))
            opened = OPEN_OVERRIDES.get((lid, st["name"]))
            if not opened and lid == "95":
                opened = MCC_OPEN
            if not opened and e:
                aliases = [norm(a) for a in LINES[lid][1]]
                starts = [v for l, v in e["lineStart"].items() if any(a in l for a in aliases)]
                opened = min(starts) if starts else e["open"]
            sid = st["id"]
            by_name[st["name"]] = sid
            stations.append({
                "id": sid, "line": lid, "name": st["name"],
                "nameEn": (e or {}).get("en") or st["name"],
                "lat": round(lat, 6), "lng": round(lng, 6),
                "depth": depth, "source": src, "open": opened,
                "image": (e or {}).get("image") if lid != "95" else None,
            })
        seqs = SEQUENCES.get(lid) or [[s["name"] for s in sorted(L["stations"], key=lambda s: s["order"])]]
        lines.append({
            "id": lid, "name": L["name"].strip(), "nameEn": LINES[lid][0],
            "color": "#" + L["hex_color"], "ring": lid in RINGS,
            "segments": [[by_name[n] for n in seq] for seq in seqs],
        })

    attach_photos(stations)
    no_open = [(s["line"], s["name"]) for s in stations if not s["open"]]
    print("without opening date:", len(no_open), no_open)

    if missing:
        raise SystemExit("stations without depth: %r" % missing)

    # Transfers: stations on different lines within walking distance.
    transfers = []
    for i, a in enumerate(stations):
        for b in stations[i + 1:]:
            if a["line"] != b["line"] and km(a["lat"], a["lng"], b["lat"], b["lng"]) < 0.33:
                transfers.append([a["id"], b["id"]])

    out = {"generated": time.strftime("%Y-%m-%d"), "lines": lines, "stations": stations, "transfers": transfers}
    path = os.path.join(ROOT, "data", "metro.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(out, open(path, "w"), ensure_ascii=False, separators=(",", ":"))
    deepest = sorted(stations, key=lambda s: -s["depth"])[:8]
    print(f"{len(lines)} lines, {len(stations)} stations, {len(transfers)} transfers -> {path}")
    print("deepest:", [(s["nameEn"], s["depth"]) for s in deepest])
    print("estimates:", sum(s["source"] == E for s in stations))


if __name__ == "__main__":
    main()
