"""Suspects: movable things on the floor (a basket, a bag, a chair), found from spots the
robot reaches on most runs like this one but missed, as the same hole, on a few runs in a row.

Pure Python + PIL, no numpy: images are Python ints used as bitsets, one bit per 5 cm block,
so a whole history takes about a hundred milliseconds.

Per room:
 1. Runs. A run counts for a room when it covered ROOM_DONE of it. A run whose stored path
    holds far less than the area the robot reported was cut short and is left out. Runs that
    didn't finish, or that skipped wide parts of what their usual company reaches (another
    job), can only show a spot clear. A room needs `min_runs` finished runs, or it says so.
 2. Company. Each run is compared only with the `k` finished runs that covered the room most
    like it did (Jaccard overlap of the room's coverage), never with the run right before or
    after it (a thing that stays a while is in their way too). A schedule that keeps off the
    walls is compared with the other runs that keep off the walls. Nothing is keyed to a
    clock time or a mode.
 3. Ghosts. A run's ghost is what `expect` of its company reached and it didn't, opened with
    a 5 x 5 square: misses thinner than 25 cm (wall strips, route wobble) are gone. A ghost
    blob is a candidate when it is object-sized and the run reached the floor around it.
 4. Places. Candidate blobs of different runs with the same shape in the same place (IoU)
    make a place; its footprint is where most of them agree.
 5. Verdicts. Every run gets a verdict at every place: clear (it went over the spot),
    blocked (its company reaches the spot, it missed it, its hole there has the spot's shape
    and the robot drove round it), partly, other (a hole of another shape) or no evidence. The company here leaves
    out runs found blocked there, repeated until nothing changes, so a thing that stood for
    several runs can't hide behind its own runs. Verdicts are taken with company sizes k-2,
    k and k+2, and each run's verdict is the majority: one size can't make or break a suspect.
 6. Suspects. A place is a suspect when it was blocked on `min_blocked` visits or more (the
    same route driven twice in a few hours is one visit), clear on others, not partly missed
    too often, not mostly in the wall band, its holes agree with each other, and its blocked
    runs bunch up in time far more than scattered route misses would (exact combinatorics
    on the run order: things arrive, stay and leave; route wobble is scattered).

Worked out and stress-tested on a real history of 88 runs: dropping runs, moving each
threshold a notch and shuffling run times (which should find nothing, and does).
"""

from __future__ import annotations

import base64
import io
import math
import re
from typing import Any

from PIL import Image, ImageChops

from history import ROOM_DONE, History, Run, _place, _unpack
from maprender import RenderedMap

BLOCK_M2 = 0.0025  # one 5 cm block
BLOCK_CM = 5

SUSPECT: dict[str, Any] = {
    "truncated": 0.5,  # a stored path under half the area the robot reported was cut short
    "min_runs": 10,  # finished runs a room needs before it can have suspects
    "k": 8,  # a run's company: this many runs that covered the room most like it did (also k-2, k+2)
    "expect": 0.75,  # "usually reached": at least this share of the company reached the block
    "skip_adjacent": 1,  # the company never includes this many runs right before or after
    "odd_missed": 0.2,  # a finished run that missed more of what its company reaches...
    "odd_wide": 0.1,  # ...or this much of it in patches wider than 25 cm did another job
    "open": 2,  # opening radius in blocks (5 x 5): thinner misses are route wobble
    "min_blob": 24,  # blocks (0.06 m²): the smallest thing
    "max_blob": 640,  # blocks (1.6 m²): bigger misses are a part of the room the run skipped
    "seed_ring": 0.6,  # a ghost blob is a candidate when the run reached this share of the floor round it
    "link": 0.35,  # candidate blobs on different runs are one place when they overlap this much (IoU)
    "clear_miss": 0.2,  # a run that missed at most this share of a spot found it clear
    "blocked_miss": 0.6,  # ...at least this share of what its company reaches there: blocked,
    "in_ghost": 0.5,  # ...with this share of the spot inside its opened miss,
    "same": 0.4,  # ...and that hole has the spot's shape (IoU): the same thing in the same place
    "comparable": 0.7,  # share of a spot a run's company must usually reach for its verdict to count
    "min_blocked": 3,  # a suspect was blocked on at least this many finished runs,
    "min_clear": 2,  # ...clear on at least this many,
    "partly": 1.0,  # ...partly missed on no more runs than this per blocked one,
    "partly_share": 0.15,  # ...or than this share of the runs that could tell, if that's more,
    "chance": 0.02,  # ...and its blocked runs bunch up like this by chance at most this often
    "edge": 3,  # blocks (15 cm): the wall band
    "max_edge": 0.5,  # a suspect may not lie mostly in the wall band
    "enclosed": 0.75,  # a blocked hole: at least this share of the floor round it is usually reached
    "same_visit_h": 12,  # a blocked run this soon after another that drove the same route...
    "same_route": 0.95,  # ...(this alike) is the same visit, not new evidence
    "solid": 0.75,  # a suspect whose holes overlap this much (median IoU, near the spot) is the same
    "agree_near": 4,  # thing each time; with less it's a person of interest (could be the route)
    "closed_after": 3,  # clear runs after which a named suspect's case is closed
    "name_reach": 6,  # blocks (30 cm): how far from a suspect a name may be pinned and still stick
    "resident_min": 16,  # blocks (0.04 m²): the smallest never-reached spot worth listing
}


# --- bitset images ---------------------------------------------------------------------------

class _Frame:
    """1-bit images on a window of the mask as Python ints (row-major, MSB first). Rows are
    padded with at least 8 empty columns to whole bytes, so shifts never spill into the next
    row. Morphology works on the whole frame, or on a band of rows cut with rows() when given
    that band's valid mask."""

    def __init__(self, w: int, h: int) -> None:
        self.w, self.h = w, h
        self.stride = (w + 8 + 7) // 8 * 8
        self.nbytes = self.stride * h // 8
        self.valid = self.bits(Image.new("1", (w, h), 1))

    def bits(self, img: Image.Image) -> int:
        pad = Image.new("1", (self.stride, self.h))
        pad.paste(img, (0, 0))
        return int.from_bytes(pad.tobytes(), "big")

    def image(self, a: int) -> Image.Image:
        return Image.frombytes("1", (self.stride, self.h), a.to_bytes(self.nbytes, "big")).crop((0, 0, self.w, self.h))

    def rows(self, a: int, y0: int, y1: int) -> int:
        """Rows y0..y1-1 as a small int with the same layout."""
        return (a >> ((self.h - y1) * self.stride)) & ((1 << ((y1 - y0) * self.stride)) - 1)

    def shift(self, a: int, dx: int, dy: int, valid: int | None = None) -> int:
        """Each pixel takes the value of the pixel (dx, dy) away from it."""
        off = dy * self.stride + dx
        return ((a << off) if off >= 0 else (a >> -off)) & (self.valid if valid is None else valid)

    def erode(self, a: int, r: int, valid: int | None = None) -> int:
        hz = a
        for d in range(1, r + 1):
            hz &= self.shift(a, d, 0, valid) & self.shift(a, -d, 0, valid)
        out = hz
        for d in range(1, r + 1):
            out &= self.shift(hz, 0, d, valid) & self.shift(hz, 0, -d, valid)
        return out

    def dilate(self, a: int, r: int, valid: int | None = None) -> int:
        hz = a
        for d in range(1, r + 1):
            hz |= self.shift(a, d, 0, valid) | self.shift(a, -d, 0, valid)
        out = hz
        for d in range(1, r + 1):
            out |= self.shift(hz, 0, d, valid) | self.shift(hz, 0, -d, valid)
        return out & (self.valid if valid is None else valid)

    def opened(self, a: int, r: int, valid: int | None = None) -> int:
        return self.dilate(self.erode(a, r, valid), r, valid) & a

    def grow_within(self, seed: int, within: int, valid: int | None = None) -> int:
        """The 8-connected parts of `within` that `seed` touches."""
        cur, prev = seed & within, -1
        while cur != prev:
            prev = cur
            cur = self.dilate(cur, 1, valid) & within
        return cur

    def pixels(self, a: int) -> list[int]:
        """Indices (y * stride + x) of the set pixels."""
        out = []
        data = a.to_bytes(self.nbytes, "big")
        for mo in re.finditer(rb"[^\x00]+", data):
            for i in range(mo.start(), mo.end()):
                byte, base = data[i], i * 8
                for k in range(8):
                    if byte & (0x80 >> k):
                        out.append(base + k)
        return out

    def from_pixels(self, px: Any) -> int:
        buf = bytearray(self.nbytes)
        for p in px:
            buf[p >> 3] |= 0x80 >> (p & 7)
        return int.from_bytes(buf, "big")

    def components(self, a: int) -> list[list[int]]:
        """8-connected blobs, as pixel indices."""
        todo = set(self.pixels(a))
        s = self.stride
        steps = (-1, 1, -s, s, -s - 1, -s + 1, s - 1, s + 1)
        blobs = []
        while todo:
            seed = todo.pop()
            blob, stack = [seed], [seed]
            while stack:
                p = stack.pop()
                for d in steps:
                    q = p + d
                    if q in todo:
                        todo.remove(q)
                        blob.append(q)
                        stack.append(q)
            blobs.append(blob)
        return blobs

    def counter_image(self, counter: list[int]) -> Image.Image:
        """A bit-sliced counter as an L image (clamped at 255)."""
        out = Image.new("L", (self.w, self.h), 0)
        for i, plane in enumerate(counter):
            if plane:
                out = ImageChops.add(out, self.image(plane).convert("L").point([0] + [min(255, 1 << i)] * 255))
        return out


def _count_into(counter: list[int], x: int) -> None:
    """Add a bitset to a bit-sliced per-pixel counter (bit planes, least significant first)."""
    carry = x
    for i in range(len(counter)):
        if not carry:
            return
        c = counter[i]
        counter[i] = c ^ carry
        carry = c & carry
    if carry:
        counter.append(carry)


def _at_least(counter: list[int], t: int) -> int:
    """Pixels where a bit-sliced counter is >= t."""
    if t <= 0:
        return -1
    if t >= 1 << len(counter):
        return 0
    gt, eq = 0, -1
    for i in range(len(counter) - 1, -1, -1):
        c = counter[i]
        if (t >> i) & 1:
            eq &= c
        else:
            gt |= eq & c
            eq &= ~c
    return gt | eq


def _extent(pts: list[tuple[int, int]]) -> tuple[int, int]:
    """Length and width in blocks, along the main axis when that is tighter than the box."""
    n = len(pts)
    mx = sum(x for x, _ in pts) / n
    my = sum(y for _, y in pts) / n
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    syy = sum((y - my) ** 2 for _, y in pts)
    sxy = sum((x - mx) * (y - my) for x, y in pts)
    a = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ca, sa = math.cos(a), math.sin(a)
    u = [(x - mx) * ca + (y - my) * sa for x, y in pts]
    v = [(y - my) * ca - (x - mx) * sa for x, y in pts]
    length, width = round(max(u) - min(u)) + 1, round(max(v) - min(v)) + 1
    bw = max(x for x, _ in pts) - min(x for x, _ in pts) + 1
    bh = max(y for _, y in pts) - min(y for _, y in pts) + 1
    if bw * bh <= length * width:
        length, width = bw, bh
    return max(length, width), min(length, width)


def _bunched(n: int, b: int, s: int) -> float:
    """Chance that b blocked runs among n judged ones fall into s or fewer unbroken stretches
    if their order were random (route misses are scattered; things that stand there stay)."""
    if b == 0 or s >= b or s >= n - b + 1:
        return 1.0
    return sum(math.comb(b - 1, j - 1) * math.comb(n - b + 1, j) for j in range(1, s + 1)) / math.comb(n, b)


# --- the analysis ----------------------------------------------------------------------------

def suspects(history: History, m: RenderedMap, flag: int | None, *,
             params: dict[str, Any] | None = None, debug: dict[str, Any] | None = None) -> dict[str, Any]:
    """Things on the floor that come and go. Coordinates are mask pixels (5 cm blocks) unless
    called robot blocks; times are unix seconds. `params` overrides SUSPECT (tuning), `debug`
    collects intermediate state (testing)."""
    P = SUSPECT if params is None else {**SUSPECT, **params}
    mask = Image.open(io.BytesIO(m.mask_png)).convert("RGBA")
    w, h = mask.size
    x0, ytop = m.left, m.top + m.img_height - 1
    red = mask.getchannel("R")

    on_map = sorted((r for r in history.runs if r.map_flag is None or flag is None or r.map_flag == flag),
                    key=lambda r: r.begin)
    laid: list[tuple[Run, Image.Image]] = []
    for r in on_map:
        g = r.grid
        if g is None:
            continue  # no path recorded
        img = _place(_unpack(g.clean, g.w, g.h), g, x0, ytop, w, h)
        if r.area and r.area >= 3 and img.histogram()[255] * BLOCK_M2 < P["truncated"] * r.area:
            continue  # the stored path was cut short
        laid.append((r, img))

    heat_r = bytearray(w * h)  # 0-254 how often blocked, 255 never reached (a permanent resident)
    heat_g = bytearray(w * h)  # suspect number
    heat_b = bytearray(w * h)  # 1 where there are runs enough to tell
    run_rooms: dict[str, dict[int, str]] = {}  # run -> room -> "full" | "clear-only" | "too few"
    rooms_out: list[dict[str, Any]] = []
    residents: list[dict[str, Any]] = []
    found: list[dict[str, Any]] = []
    pad = P["open"] + 6

    for rid in sorted(m.rooms):
        room_img = red.point([255 if v == rid else 0 for v in range(256)], "1")
        box = room_img.getbbox()
        if not box:
            continue
        win = (max(0, box[0] - pad), max(0, box[1] - pad), min(w, box[2] + pad), min(h, box[3] + pad))
        fr = _Frame(win[2] - win[0], win[3] - win[1])
        s = fr.stride
        room = fr.bits(room_img.crop(win))
        n_room = room.bit_count()
        edge = room & ~fr.erode(room, P["edge"])

        ev: list[dict[str, Any]] = []  # the runs that cleaned this room, oldest first
        for r, img in laid:
            c = fr.bits(img.crop(win)) & room
            if c.bit_count() >= ROOM_DONE * n_room:
                ev.append({"t": len(ev), "run": r, "c": c, "n": c.bit_count(), "full": r.complete is not False, "odd": False})
        info: dict[str, Any] = {"id": rid, "runs": len(ev)}
        rooms_out.append(info)
        sim = [[0.0] * len(ev) for _ in ev]
        for i in range(len(ev)):
            for j in range(i + 1, len(ev)):
                inter = (ev[i]["c"] & ev[j]["c"]).bit_count()
                sim[i][j] = sim[j][i] = inter / (ev[i]["n"] + ev[j]["n"] - inter)

        likeness = [sorted(range(len(ev)), key=lambda j: -sim[i][j]) for i in range(len(ev))]  # most alike first

        def company(i: int, pool: list[int], kv: int, skip: int) -> list[int]:
            ok = set(pool)
            out = []
            for j in likeness[i]:
                if j != i and j in ok and abs(j - i) > skip:
                    out.append(j)
                    if len(out) == kv:
                        break
            return out

        def usual(refs: list[int]) -> int:
            ctr: list[int] = []
            for j in refs:
                _count_into(ctr, ev[j]["c"])
            return _at_least(ctr, max(1, math.ceil(P["expect"] * len(refs) - 1e-9))) & room

        # Finished runs that did another job (skipped wide parts of what their company reaches)
        # can show a spot clear, but not blocked.
        full = [e["t"] for e in ev if e["full"]]
        for i in full:
            cons = usual(company(i, full, P["k"], 0))
            cn = cons.bit_count()
            missed = cons & ~ev[i]["c"]
            if not cn or missed.bit_count() > P["odd_missed"] * cn or fr.opened(missed, P["open"]).bit_count() > P["odd_wide"] * cn:
                ev[i]["odd"] = True
        judge = [i for i in full if not ev[i]["odd"]]
        info["judged"] = len(judge)
        info["clear_only"] = [e["run"].id for e in ev if e["t"] not in judge]
        for e in ev:
            run_rooms.setdefault(e["run"].id, {})[rid] = "full" if e["t"] in judge else "clear-only"
        if len(judge) < P["min_runs"]:
            info["status"] = "too_few_runs"
            info["note"] = (f"cleaned on {len(judge)} finished run{'s' if len(judge) != 1 else ''}; "
                            f"needs {P['min_runs']} to tell things on the floor from changes in the route")
            for e in ev:
                run_rooms[e["run"].id][rid] = "too few"
            continue
        info["status"] = "ok"
        most = len(judge) - 1 - 2 * P["skip_adjacent"]
        views = sorted({max(3, min(kv, most)) for kv in (P["k"] - 2, P["k"], P["k"] + 2)})
        base_k = views[len(views) // 2]

        # Pass 1: each run's ghost against its company; object-like blobs in it become places.
        blocked_ctr: list[int] = []
        expect_ctr: list[int] = []
        places: list[dict[str, Any]] = []
        for kv in [base_k] + [v for v in views if v != base_k]:
            blobs: list[dict[str, Any]] = []
            for i in judge:
                e_i = usual(company(i, judge, kv, P["skip_adjacent"]))
                c_i = ev[i]["c"]
                ghost = fr.opened(e_i & ~c_i, P["open"])
                if kv == base_k:
                    _count_into(expect_ctr, e_i)
                    _count_into(blocked_ctr, ghost)
                for px in fr.components(ghost):
                    if not P["min_blob"] <= len(px) <= P["max_blob"]:
                        continue
                    gb = fr.from_pixels(px)
                    ring = fr.dilate(gb, 4) & ~fr.dilate(gb, 1) & room & (e_i | c_i)
                    rn = ring.bit_count()
                    if rn and (ring & c_i).bit_count() >= P["seed_ring"] * rn:
                        blobs.append({"t": i, "bits": gb, "n": len(px)})

            parent = list(range(len(blobs)))

            def find(a: int) -> int:
                while parent[a] != a:
                    parent[a] = parent[parent[a]]
                    a = parent[a]
                return a

            for a in range(len(blobs)):
                for b in range(a + 1, len(blobs)):
                    if blobs[a]["t"] != blobs[b]["t"]:
                        inter = (blobs[a]["bits"] & blobs[b]["bits"]).bit_count()
                        if inter and inter >= P["link"] * (blobs[a]["n"] + blobs[b]["n"] - inter):
                            parent[find(a)] = find(b)
            groups: dict[int, list[dict[str, Any]]] = {}
            for a, bl in enumerate(blobs):
                groups.setdefault(find(a), []).append(bl)
            for members in groups.values():
                if len(members) == 1:
                    foot = members[0]["bits"]
                else:
                    ctr: list[int] = []
                    for bl in members:
                        _count_into(ctr, bl["bits"])
                    comps = fr.components(fr.opened(_at_least(ctr, max(2, (len(members) + 1) // 2)), 1))
                    if not comps:
                        continue
                    foot = fr.from_pixels(max(comps, key=len))
                area = foot.bit_count()
                if area < P["min_blob"]:
                    continue
                # Found again with another company size: judge it once.
                if any((foot & o["foot"]).bit_count() * 2 >= area + o["area"] - (foot & o["foot"]).bit_count() for o in places):
                    continue
                places.append({"foot": foot, "area": area, "seen": {bl["t"] for bl in members}})

        # Pass 2: a verdict for every run at every place.
        def judge_place(pl: dict[str, Any], kv: int) -> tuple[list[str | None], dict[int, int]]:
            """Each run's verdict at a place, and the hole each blocked run left there."""
            area = pl["area"]
            band = fr.valid  # holes grow over the whole room, so a long lane miss isn't cut to the spot's size
            F, room_b = pl["foot"], room
            cov = [e["c"] for e in ev]
            out_of_it = set(pl["seen"])  # runs that had it in their ghost: likely blocked, no reference
            verdicts: list[str | None] = []
            holes_at: dict[int, int] = {}
            for _round in range(4):
                verdicts = []
                holes_at = {}
                for e in ev:
                    i, c = e["t"], cov[e["t"]]
                    if (F & c).bit_count() >= (1 - P["clear_miss"]) * area:
                        verdicts.append("clear")  # it went over the spot, so nothing stood there
                        continue
                    if i not in judge:
                        verdicts.append(None)  # didn't finish, or another job: only a visit counts
                        continue
                    refs = company(i, [j for j in judge if j not in out_of_it], kv, P["skip_adjacent"])  # without runs blocked here
                    ctr: list[int] = []
                    for j in refs:
                        _count_into(ctr, cov[j])
                    usual_here = _at_least(ctr, max(1, math.ceil(P["expect"] * len(refs) - 1e-9))) & room_b if refs else 0
                    fe = F & usual_here
                    fen = fe.bit_count()
                    if fen < P["comparable"] * area:
                        verdicts.append(None)  # its kind of run doesn't go there
                        continue
                    miss = (fe & ~c).bit_count() / fen
                    if miss <= P["clear_miss"]:
                        verdicts.append("clear")
                    elif miss < P["blocked_miss"]:
                        verdicts.append("partly")
                    else:
                        holes = fr.opened(usual_here & ~c, P["open"], band)
                        if (F & holes).bit_count() < P["in_ghost"] * area:
                            verdicts.append("partly")  # missed in thin strips: the route, not a thing
                            continue
                        hole = fr.grow_within(F & holes, holes, band)
                        inter = (hole & F).bit_count()
                        if inter < P["same"] * (hole.bit_count() + area - inter):
                            verdicts.append("other")
                            continue
                        # Enclosed: the robot usually reaches the floor all round it. A hole open
                        # to floor its kind of run never reaches is the edge of the route.
                        ring = fr.dilate(hole, 3, band) & ~fr.dilate(hole, 1, band) & room_b
                        rn = ring.bit_count()
                        if rn and (ring & usual_here).bit_count() >= P["enclosed"] * rn:
                            verdicts.append("blocked")
                            holes_at[i] = hole
                        else:
                            verdicts.append("partly")
                now_blocked = {i for i, v in enumerate(verdicts) if v == "blocked"}
                if now_blocked == out_of_it:
                    break
                out_of_it = now_blocked
            return verdicts, holes_at

        for pl in places:
            judged_views = [judge_place(pl, kv) for kv in views]
            per_view = [v for v, _ in judged_views]
            verdicts = []
            for votes in zip(*per_view):
                top = max(set(votes), key=lambda v: (votes.count(v), v is None))
                verdicts.append(top if votes.count(top) * 2 > len(votes) else "partly")
            b = [i for i, v in enumerate(verdicts) if v == "blocked"]
            seq, last_b, visit_runs = [], None, []  # one visit: a blocked run hours after another blocked run that drove the same route
            for i, v in enumerate(verdicts):
                if v not in ("blocked", "clear"):
                    continue
                if (v == "blocked" and last_b is not None and sim[i][last_b] >= P["same_route"]
                        and ev[i]["run"].begin - ev[last_b]["run"].begin < P["same_visit_h"] * 3600):
                    continue
                seq.append(v)
                if v == "blocked":
                    last_b = i
                    visit_runs.append(i)
            judged = seq
            visits = judged.count("blocked")
            # The same thing leaves the same hole. On this history the real ones agree at 0.83-0.84;
            # route artefacts that slip through when a run is dropped at 0.39-0.67. Close calls
            # are kept but shown as persons of interest rather than hidden.
            near = fr.dilate(pl["foot"], P["agree_near"])  # compare the holes where the thing stood, not the lanes they run into
            holes = [next((hv[i] for _, hv in judged_views if i in hv), 0) & near for i in visit_runs]
            ious = sorted(
                (a & b).bit_count() / max(1, (a | b).bit_count())
                for x, a in enumerate(holes) for b in holes[x + 1:]
            )
            agree = ious[len(ious) // 2] if ious else 0.0
            pl["agree"] = agree
            pl["holes"] = {i: hv[i] for _, hv in reversed(judged_views) for i in hv}
            segs = sum(1 for i, v in enumerate(judged) if v == "blocked" and (i == 0 or judged[i - 1] != "blocked"))
            n_partly = sum(1 for v in verdicts if v in ("partly", "other"))
            pl.update(verdicts=verdicts, blocked=b, n_partly=n_partly, n_clear=judged.count("clear"),
                      chance=_bunched(len(judged), visits, segs), edge_share=(pl["foot"] & edge).bit_count() / pl["area"])
            pl["ok"] = (
                visits >= P["min_blocked"]
                and pl["n_clear"] >= P["min_clear"]
                and n_partly <= max(P["partly"] * len(b), P["partly_share"] * (len(judged) + n_partly))
                and pl["chance"] <= P["chance"]
                and pl["edge_share"] < P["max_edge"]
            )

        # The most convincing first; one thing is never two suspects.
        kept: list[dict[str, Any]] = []
        for pl in sorted(places, key=lambda p: (p["chance"], -len(p["blocked"]))):
            if pl["ok"] and not any((pl["foot"] & o["foot"]).bit_count() >= 0.3 * min(pl["area"], o["area"])
                                    and set(pl["blocked"]) & set(o["blocked"]) for o in kept):
                kept.append(pl)
        info["suspects"] = len(kept)
        if debug is not None:
            debug.setdefault("rooms", {})[rid] = {"frame": fr, "win": win, "ev": ev, "judge": judge, "views": views,
                                                  "places": places, "kept": kept, "room": room}

        # Heat: how often each block was blocked among the runs that usually reach it; and the
        # permanent residents, floor never reached on any run of a room that does get cleaned.
        bimg = fr.counter_image(blocked_ctr).tobytes()
        eimg = fr.counter_image(expect_ctr).tobytes()
        ever = 0
        for e in ev:
            ever |= e["c"]
        res_set: set[int] = set()
        for px in fr.components(fr.opened(room & ~ever, 1)):
            if len(px) < P["resident_min"]:
                continue
            res_set.update(px)
            xs, ys = [p % s for p in px], [p // s for p in px]
            residents.append({"room": rid, "cx": round(sum(xs) / len(px) + win[0], 1), "cy": round(sum(ys) / len(px) + win[1], 1),
                              "area": round(len(px) * BLOCK_M2, 2), "runs": len(ev),
                              "bbox": [min(xs) + win[0], min(ys) + win[1], max(xs) + win[0] + 1, max(ys) + win[1] + 1]})
        for p in fr.pixels(room):
            y, x = divmod(p, s)
            o, q = (y + win[1]) * w + x + win[0], y * fr.w + x
            if p in res_set:
                heat_r[o], heat_b[o] = 255, 1
            elif eimg[q] >= 3:
                heat_r[o], heat_b[o] = min(254, round(254 * bimg[q] / eimg[q])), 1

        for pl in kept:
            found.append(_describe(rid, pl, ev, fr, win, x0, ytop, room, edge))
            found[-1]["solid"] = pl["agree"] >= P["solid"]  # the same hole every time, or a person of interest

    # Number suspects by when they first turned up; paint them on the heat map; names stick to
    # the spot they were pinned to.
    found.sort(key=lambda sp: (sp["first"], sp["room"], sp["cx"]))
    for n, sp in enumerate(found, 1):
        sp["n"] = n
        for x, y in sp["_px"]:
            heat_g[y * w + x] = min(255, n)
    _names(found, history, flag, x0, ytop, P)
    for sp in found:
        sp.pop("_px", None)
    clear_at = {sp["n"]: sp.pop("_clear_runs") for sp in found}

    # The tape: every run that could show a spot blocked, oldest first, and who was in its way.
    tape = []
    for r in on_map:
        if any(v == "full" for v in run_rooms.get(r.id, {}).values()):
            tape.append({
                "id": r.id, "at": r.begin,
                "suspects": [sp["n"] for sp in found if r.id in sp["runs"]],  # in its way
                "clear": [n for n, ids in clear_at.items() if r.id in ids],  # it went over their spot; the rest it didn't check
            })

    heat = Image.merge("RGB", [Image.frombytes("L", (w, h), bytes(c)) for c in (heat_r, heat_g, heat_b)])
    buf = io.BytesIO()
    heat.save(buf, format="PNG", optimize=True)
    return {
        "available": True,
        "map": m.image_version,
        "counted": len(tape),  # runs that could show a spot blocked in some room
        "skipped": len(on_map) - len(tape),  # no path, a path cut short, unfinished, another job, too few runs
        "suspects": found,
        "residents": residents,
        "rooms": rooms_out,
        "tape": tape,
        # Mask-sized RGB PNG. R: 0-254 the share of the runs that usually reach a block that
        # found it blocked, 255 never reached (a permanent resident); G: suspect number;
        # B: 1 where there are runs enough to tell.
        "heat": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "closed_after": P["closed_after"],
        "min_runs": P["min_runs"],
    }


def pin_name(history: History, payload: dict[str, Any], flag: int | None, x: int, y: int, name: str) -> None:
    """Name the suspect whose anchor is (x, y), or take its name off (empty name). Any name
    that would land on it goes, so a rename never leaves an old one behind."""
    sp = next((s for s in payload.get("suspects") or [] if s.get("anchor") == [x, y]), None)
    history.name_suspect(flag, x, y, name, tuple(sp["box"]) if sp else None)


def _describe(rid: int, pl: dict[str, Any], ev: list[dict[str, Any]], fr: _Frame, win: tuple[int, int, int, int],
              x0: int, ytop: int, room: int, edge: int) -> dict[str, Any]:
    """One suspect as the app shows it."""
    s = fr.stride
    pts = [(p % s + win[0], p // s + win[1]) for p in fr.pixels(pl["foot"])]
    cx = sum(x for x, _ in pts) / len(pts)
    cy = sum(y for _, y in pts) / len(pts)
    # The anchor: the footprint block nearest its centre, so it lies on the thing even if it's bent.
    ax, ay = min(pts, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2)
    verdicts = pl["verdicts"]
    blocked = [ev[i]["run"] for i in pl["blocked"]]
    last = blocked[-1]
    # Runs since it was last in the way that went over the spot; only finished ones close a case.
    since = [ev[i] for i, v in enumerate(verdicts) if v == "clear" and i > pl["blocked"][-1]]
    after = [e["run"] for e in since if e["full"]]
    there = verdicts[-1] == "blocked"
    # Its size: what the blocked runs actually missed there, wall side included (the footprint is
    # trimmed to floor the company reaches, which understates a thing against a wall).
    sizes = []
    reach = (fr.dilate(pl["foot"], 1) | (edge & fr.dilate(pl["foot"], 3))) & room  # a little round it, and on to a wall
    for i in pl["blocked"]:
        missed = fr.grow_within(pl["foot"], reach & ~ev[i]["c"])
        if missed:
            sizes.append(_extent([(p % s, p // s) for p in fr.pixels(missed)]))
    length, width = (sorted(x for x, _ in sizes)[len(sizes) // 2], sorted(y for _, y in sizes)[len(sizes) // 2]) if sizes else _extent(pts)
    since_first = [v for v in verdicts[pl["blocked"][0]:] if v in ("blocked", "clear")]
    return {
        "room": rid,
        "cx": round(cx, 1), "cy": round(cy, 1),  # centre, mask pixels (5 cm blocks)
        "anchor": [x0 + ax, ytop - ay],  # a block it covers, robot block coordinates: its name is pinned here
        "bbox": [min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts) + 1, max(y for _, y in pts) + 1],
        "w": length * BLOCK_CM, "h": width * BLOCK_CM,  # size in cm, along its main axis
        "area": round(len(pts) * BLOCK_M2, 2),  # m²
        "blocked": len(blocked),  # finished runs it was in the way on
        "of": len(since_first),  # runs that could tell since it first turned up
        "first": blocked[0].begin,
        "last": last.begin,
        "there": there,  # in the way on the latest run that cleaned its room
        "status": "there" if there else ("gone" if since else "unchecked"),  # unchecked: no run has been over it since
        "clear": len(after),  # finished runs since that went over the spot
        "clear_since": since[0]["run"].end if since else None,  # when the first run over it again ended
        "runs": [r.id for r in blocked],
        # A block it covers and its box, in robot blocks: names are pinned to it, and forgotten by the box.
        "box": [x0 + min(x for x, _ in pts), ytop - max(y for _, y in pts), x0 + max(x for x, _ in pts), ytop - min(y for _, y in pts)],
        "_clear_runs": {ev[i]["run"].id for i, v in enumerate(verdicts) if v == "clear"},
        "name": None,
        "closed": False,
        "_px": pts,
    }


def _names(found: list[dict[str, Any]], history: History, flag: int | None, x0: int, ytop: int, P: dict[str, Any]) -> None:
    """Give each suspect the name pinned on its spot ({flag, x, y in robot blocks, name,
    created}): the suspect covering the pinned block, else the nearest within name_reach.
    When several qualify, the one that had turned up by the time it was named, seen last.
    A suspect keeps the newest name that lands on it."""
    reach2 = P["name_reach"] ** 2
    for nm in sorted(getattr(history, "names", None) or [], key=lambda n: n.get("created") or 0):
        if flag is not None and nm.get("flag") is not None and nm.get("flag") != flag:
            continue
        try:
            px, py, created = int(nm["x"]) - x0, ytop - int(nm["y"]), nm.get("created") or 0
        except (KeyError, TypeError, ValueError):
            continue
        best = None
        for sp in found:
            d2 = min((x - px) ** 2 + (y - py) ** 2 for x, y in sp["_px"])
            if d2 > reach2:
                continue
            known = sp["first"] <= created
            key = (d2 > 0, not known, -sp["last"] if known else sp["first"], d2)
            if best is None or key < best[0]:
                best = (key, sp)
        if best:
            best[1]["name"], best[1]["named"] = nm["name"], created or None
    for sp in found:
        sp["closed"] = bool(sp["name"]) and not sp["there"] and sp["clear"] >= P["closed_after"]
        sp.pop("named", None)

