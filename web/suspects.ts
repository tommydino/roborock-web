// Suspects: the things that come and go on the floor. A spot the robot reaches on most
// runs but not on some has had something standing on it: a bag, a basket, a chair. The
// server works them out from the history of every run (suspects.py); this view puts them
// on the map as numbered evidence tags, with a wanted poster for each, a tape to step
// through the runs and see who was in the way when, and a name you can give each one.

import { api, devicePath } from "./api";
import { $, $opt, closest, cssVar, errorMessage, esc, fmtArea, hexRgb, icon, pct, toast } from "./dom";
import { decodeMask, refreshMapOverlays, toBase } from "./map/core";
import { mapImg } from "./map/elements";
import { S } from "./state";
import type { Suspect, Suspects } from "./types";

const panel = $("#sus-panel");
const tagsEl = $("#sus-tags");

const RESIDENT = 255; // heat value: never reached, in a room that does get cleaned

/** Which run of the tape is shown (an index into S.sus.tape), or null for all runs. */
let frame: number | null = null;
let focus: string | null = null; // the suspect whose poster or tag was clicked (by key)
let naming: string | null = null; // the suspect whose name is being typed (by key)...
let draft = ""; // ...what's typed so far, kept across redraws
let justOpened = false; // focus the name field once, when it opens
let residentsOpen = false;
let playing: ReturnType<typeof setInterval> | null = null;

// A suspect's number can change when an older one ages out of the history; the spot it was
// first pinned to doesn't, so selections follow that.
const key = (s: Suspect) => s.anchor.join(":");
const byKey = (k: string | null) => (k ? S.sus?.suspects?.find((s) => key(s) === k) : undefined);

const room = (id: number) => S.map?.rooms.find((r) => r.id === id)?.name ?? `Room ${id}`;
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const when = (ts: number) =>
  `${day(ts)}, ${new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
const size = (s: Suspect) => `about ${Math.round(s.w / 5) * 5} × ${Math.round(s.h / 5) * 5} cm`;
const runs = (n: number) => (n === 1 ? "1 run" : `${n} runs`);
const kind = (s: Suspect) => (s.solid ? "Suspect" : "Person of interest");
const title = (s: Suspect) => (s.name ? s.name : `${kind(s)} #${s.n}`);
const closedAfter = () => S.sus?.closed_after ?? 3;
const area = (m2: number) => (m2 < 0.1 ? `${Math.round(m2 * 10_000)} cm²` : fmtArea(m2));

/** The analysis was worked out for another layout (a new map, another floor): don't trust it. */
const stale = () => !!S.sus && !!S.map && S.sus.map !== S.map.image;

/** Where a suspect stands in the case: what its spot is painted with, and its badge. */
type Stage = "there" | "recent" | "gone" | "unchecked" | "closed";
function stage(s: Suspect): Stage {
  if (s.closed) return "closed";
  if (s.there) return "there";
  if (s.status === "unchecked") return "unchecked";
  return s.clear >= closedAfter() ? "gone" : "recent";
}

/** Pick a line by a stable number, so a suspect keeps its joke between redraws. */
const pick = <T>(lines: T[], seed: number): T => lines[Math.abs(seed) % lines.length];

/** The wanted poster's one-liner. Facts first, the joke rides on them. */
function quip(s: Suspect): string {
  const who = s.name ? esc(s.name) : "It";
  if (!s.solid && !s.closed) {
    return pick(
      [
        `Left a slightly different hole each time. Could be something, could be the robot taking a lazy line. Not enough for a warrant.`,
        `The evidence is a bit smudged: the gaps don't quite match from run to run. Keeping it on file.`,
      ],
      s.n,
    );
  }
  switch (stage(s)) {
    case "closed":
      return pick(
        [
          `Case closed. ${who} hasn't been in the way for ${runs(s.clear)}. Good work, detective.`,
          `Case closed. Clear for ${runs(s.clear)} in a row. The robot would like to thank you for your cooperation.`,
        ],
        s.n,
      );
    case "there":
      return pick(
        [
          `In the way on ${s.blocked} of the last ${runs(s.of)} here. Still at the scene. Not answering questions.`,
          `First spotted ${day(s.first)}, still there on the latest run. The robot has filed a complaint.`,
          `${who} was in the way again on ${day(s.last)}. That's ${s.blocked} times now. It knows what it did.`,
        ],
        s.n,
      );
    case "unchecked":
      return pick(
        [
          `Last seen ${day(s.last)}. No run has been all the way over that spot since, so nobody can say it left.`,
          `The robot hasn't been properly over that spot since ${day(s.last)}. It might still be there. It might be watching.`,
        ],
        s.n,
      );
    case "gone":
      return pick(
        [
          `Not seen for ${runs(s.clear)}. Either it went home, or it's planning something.`,
          `Gone since ${day(s.clear_since ?? s.last)}. Witnesses describe it as ${size(s)}.${s.name ? "" : " Give it a name to close the case."}`,
        ],
        s.n,
      );
    default:
      return pick(
        [
          `Last seen ${day(s.last)}, and the spot has been clear since. Keeping an eye on it.`,
          `Moved out after ${day(s.last)}. Too early to close the file.`,
        ],
        s.n,
      );
  }
}

function statusBadge(s: Suspect): string {
  switch (stage(s)) {
    case "closed":
      return `<span class="sus-badge closed">${icon("check")}Case closed</span>`;
    case "there":
      return `<span class="sus-badge there">At large</span>`;
    case "unchecked":
      return `<span class="sus-badge gone">Not checked since ${esc(day(s.last))}</span>`;
    default:
      return `<span class="sus-badge gone">Clear since ${esc(day(s.clear_since ?? s.last))}</span>`;
  }
}

/* ---- loading ---- */

let loading: Promise<void> | null = null;
let loadedAt = 0;
let gen = 0; // bumped when another robot is picked, so a late answer for the old one is dropped
let retry: ReturnType<typeof setTimeout> | undefined;

export function loadSuspects(): Promise<void> {
  if (loading || !S.duid) return loading ?? Promise.resolve();
  const mine = ++gen;
  loading = (async () => {
    try {
      const sus = await api<Suspects>(devicePath("suspects"));
      if (gen === mine) await apply(sus);
    } catch (e) {
      if (!S.sus && gen === mine) toast(`Couldn't work out the suspects: ${errorMessage(e)}`, true);
    } finally {
      if (gen === mine) {
        loadedAt = Date.now();
        loading = null;
      }
    }
  })();
  return loading;
}

async function apply(sus: Suspects): Promise<void> {
  S.susHeat = sus.heat ? await decodeMask(sus.heat) : null;
  S.sus = sus;
  if (frame != null && frame >= (sus.tape ?? []).length) frame = null;
  if (!byKey(focus)) focus = null;
  if (!byKey(naming)) naming = null;
  if (S.viewMode === "suspects") {
    if (S.map) mapImg.src = suspectsImage();
    renderSusPanel();
    refreshMapOverlays();
  }
}

/** Another robot was picked: forget this one's suspects and anything picked in the view. */
export function resetSuspects(): void {
  stop();
  clearTimeout(retry);
  frame = focus = naming = null;
  draft = "";
  gen++;
  loading = null;
  loadedAt = 0;
  renderSusPanel();
}

/** A new map came in, or a run finished: look again, at most every 30 s. */
export function suspectsMapChanged(): void {
  if (S.viewMode !== "suspects" || !S.map || (S.sus && !stale())) return;
  const wait = 30_000 - (Date.now() - loadedAt);
  clearTimeout(retry);
  if (wait <= 0) void loadSuspects();
  else retry = setTimeout(() => suspectsMapChanged(), wait); // don't drop it: try again when allowed
  renderSuspectTags(); // a stale analysis shows no tags meanwhile
}

setInterval(() => {
  if (S.viewMode === "suspects" && !document.hidden && Date.now() - loadedAt > 120_000) void loadSuspects();
}, 20_000);

/* ---- the map image ---- */

type RGBA = [number, number, number, number];
let imgCache = { key: "", url: "" };

function colours() {
  const rgba = (name: string, fallback: string): RGBA => [...hexRgb(cssVar(name) || fallback), 255];
  return {
    paper: rgba("--sus-paper", "#f7f3ea"),
    wall: rgba("--sus-wall", "#6f6a62"),
    furniture: rgba("--sus-furniture", "#e2ddd2"),
    nodata: rgba("--sus-nodata", "#ebe8e1"),
    resident: rgba("--sus-resident", "#b5afa4"),
    stage: {
      there: rgba("--sus-3", "#b3261e"),
      recent: rgba("--sus-2", "#d9662f"),
      gone: rgba("--sus-0", "#f2d27b"),
      unchecked: rgba("--sus-unchecked", "#c7bfd9"),
      closed: rgba("--sus-closed", "#cfcac0"),
    } as Record<Stage, RGBA>,
    ghost: rgba("--sus-ghost", "#b3261e"),
    trace: rgba("--sus-trace", "#ecdcb4"),
    hatch: cssVar("--sus-hatch") || "rgba(111, 106, 98, 0.35)",
  };
}

/** The tape frame's verdicts: who was in the way, and whose spot it went over and found clear.
 *  Any other suspect wasn't checked on that run. */
function frameSets(): { blocked: Set<number>; clear: Set<number> } | null {
  const at = frame != null ? S.sus?.tape?.[frame] : undefined;
  return at ? { blocked: new Set(at.suspects), clear: new Set(at.clear ?? []) } : null;
}

/** The floor with each suspect's spot coloured by where its case stands (at large, just gone,
 *  long gone, not checked, closed), or, on a frame of the tape, solid where a suspect stood
 *  that run, faint where the run found its spot clear, and blank where it didn't look. */
export function suspectsImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const heat = !stale() && S.susHeat && S.susHeat.w === mask.w && S.susHeat.h === mask.h ? S.susHeat : null;
  const at = frameSets();
  const c = colours();
  const stages = new Map((S.sus?.suspects ?? []).map((s) => [s.n, stage(s)]));
  const focusN = byKey(focus)?.n ?? null;
  const k = [m.mask.length, m.mask.slice(-48), m.width, S.sus?.heat?.slice(-48) ?? "", !!heat, [...stages].join(), frame, focusN, Object.values(c.stage).join(), c.paper.join()].join(":");
  if (imgCache.key === k) return imgCache.url;

  const { w, h, data } = mask;
  const small = canvas(w, h);
  const img = small.getContext("2d")!.createImageData(w, h);
  const hatchSrc = canvas(w, h);
  const hatchImg = hatchSrc.getContext("2d")!.createImageData(w, h);
  for (let o = 0; o < data.length; o += 4) {
    if (!data[o + 3]) continue;
    const kind = data[o + 1];
    let px: RGBA = c.paper;
    if (kind === 1) px = c.wall;
    else if (kind === 2) px = c.furniture;
    else if (!heat || !heat.data[o + 2]) {
      px = c.nodata; // not enough runs here to tell
      hatchImg.data.set([0, 0, 0, 255], o);
    } else if (heat.data[o] === RESIDENT) {
      px = c.resident;
      hatchImg.data.set([0, 0, 0, 255], o);
    } else {
      const n = heat.data[o + 1];
      const st = n ? stages.get(n) : undefined;
      if (st) {
        if (at) px = at.blocked.has(n) ? c.ghost : at.clear.has(n) ? c.trace : c.paper;
        else px = c.stage[st];
        if (focusN != null && n !== focusN) px = fade(px, c.paper);
      }
    }
    img.data.set(px, o);
  }
  small.getContext("2d")!.putImageData(img, 0, 0);
  hatchSrc.getContext("2d")!.putImageData(hatchImg, 0, 0);

  const big = canvas(m.width, m.height);
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);
  // Hatch what can't be judged and the permanent residents, like Freshness does for "no data".
  const hatch = canvas(big.width, big.height);
  const hctx = hatch.getContext("2d")!;
  hctx.imageSmoothingEnabled = false;
  hctx.drawImage(hatchSrc, 0, 0, big.width, big.height);
  hctx.globalCompositeOperation = "source-in";
  hctx.strokeStyle = c.hatch;
  hctx.lineWidth = 1.5;
  hctx.beginPath();
  for (let d = -big.height; d < big.width; d += 8) {
    hctx.moveTo(d, big.height);
    hctx.lineTo(d + big.height, 0);
  }
  hctx.stroke();
  ctx.drawImage(hatch, 0, 0);

  imgCache = { key: k, url: big.toDataURL("image/png") };
  return imgCache.url;
}

const fade = (px: RGBA, to: RGBA): RGBA => [0, 1, 2].map((i) => Math.round(px[i] * 0.35 + to[i] * 0.65)).concat(255) as RGBA;

function canvas(w: number, h: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = w;
  el.height = h;
  return el;
}

/* ---- evidence tags on the map ---- */

/** Numbered tags at each suspect, drawn with the other overlays. None while the map is being
 *  edited or the analysis is for another layout. */
export function renderSuspectTags(): void {
  const m = S.map;
  const list = S.viewMode === "suspects" && !S.edit && !stale() ? (S.sus?.suspects ?? []) : [];
  if (!m || !list.length) {
    tagsEl.innerHTML = "";
    return;
  }
  const at = frameSets();
  tagsEl.innerHTML = list
    .map((s) => {
      // Near the right edge the tag hangs to the left of its spot, so a long name stays on the map.
      const flip = (s.cx * m.scale) / m.width > 0.7;
      const seen = !at ? "" : at.blocked.has(s.n) ? "" : at.clear.has(s.n) ? "away" : "unchecked";
      const cls = ["sus-tag", flip ? "flip" : "", s.closed ? "closed" : "", s.solid ? "" : "poi", seen, focus === key(s) ? "focus" : ""].join(" ");
      const label = `${title(s)}: ${size(s)}, in the way on ${s.blocked} of ${runs(s.of)}`;
      return `<button class="${cls}" data-sus="${esc(key(s))}" style="left:${pct(s.cx * m.scale, m.width)};top:${pct(s.cy * m.scale, m.height)}" title="${esc(label)}" aria-label="${esc(label)}"><b>${s.n}</b>${s.name ? `<span>${esc(s.name)}</span>` : ""}</button>`;
    })
    .join("");
}

tagsEl.addEventListener("click", (e) => {
  const tag = closest(e.target, "[data-sus]");
  if (!tag || S.suppressClick) return; // after a pan, the map's own handler clears the flag
  e.stopPropagation(); // not a click on the room under it
  setFocus(tag.dataset.sus ?? null);
  panel.querySelector(`[data-poster="${CSS.escape(tag.dataset.sus ?? "")}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

function setFocus(k: string | null): void {
  focus = focus === k ? null : k;
  redraw();
}

/** Everything the view shows, after something picked in it changed. */
function redraw(): void {
  if (S.viewMode !== "suspects") return;
  if (S.map) mapImg.src = suspectsImage();
  renderSuspectTags();
  renderSusPanel();
}

/* ---- hover ---- */

/** What the Suspects view says about the spot under the pointer (null: nothing to say). */
export function suspectTip(e: PointerEvent): string | null {
  const m = S.map;
  const mask = S.mask;
  const heat = S.susHeat;
  if (!m || !mask || !heat || heat.w !== mask.w || heat.h !== mask.h || !S.sus?.available || stale()) return null;
  const p = toBase(e);
  const x = Math.floor(p.x / m.scale);
  const y = Math.floor(p.y / m.scale);
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return null;
  const o = (y * mask.w + x) * 4;
  if (!mask.data[o + 3] || mask.data[o + 1] === 1 || mask.data[o + 1] === 2) return null;
  const where = mask.data[o] ? `<b>${esc(room(mask.data[o]))}</b>` : "<b>Here</b>";
  if (!heat.data[o + 2]) return `${where}<br>Not enough finished runs here to tell`;
  if (heat.data[o] === RESIDENT) {
    const r = S.sus.residents?.find((r) => Math.abs(r.cx - x) + Math.abs(r.cy - y) < 40 && r.room === mask.data[o]);
    return `<b>Permanent resident</b><br>Never reached${r ? ` on ${runs(r.runs)}` : ""}. Under something with a lot of legs, probably`;
  }
  const n = heat.data[o + 1];
  const s = n ? S.sus.suspects?.find((x) => x.n === n) : null;
  if (s) {
    const at = frameSets();
    const now = !at ? "" : at.blocked.has(s.n) ? "<br>In the way on this run" : at.clear.has(s.n) ? "<br>Not here on this run" : "<br>Not checked on this run";
    return `<b>${esc(title(s))}</b> · ${size(s)}<br>In the way on ${s.blocked} of ${runs(s.of)}${now}`;
  }
  return `${where}<br>Nothing suspicious here`;
}

/* ---- the panel ---- */

export function renderSusPanel(): void {
  const on = S.viewMode === "suspects";
  panel.hidden = !on;
  $("#map-card").classList.toggle("is-sus", on);
  if (!on) {
    stop();
    naming = null;
    tagsEl.innerHTML = "";
    return;
  }
  const f = S.sus;
  if (!f || !S.map) {
    panel.innerHTML = `<div class="skel" style="height:18px;width:50%"></div>${'<div class="skel" style="height:64px;margin-top:14px"></div>'.repeat(3)}`;
    return;
  }
  if (!f.available) {
    panel.innerHTML = `<p class="muted">There's no map yet, so there's nobody to suspect. Run a full clean first.</p>`;
    return;
  }
  const list = [...(f.suspects ?? [])].sort((a, b) => Number(b.there) - Number(a.there) || Number(a.closed) - Number(b.closed) || b.last - a.last);
  const atLarge = list.filter((s) => s.there).length;
  const poi = list.filter((s) => !s.solid).length;
  const closed = list.filter((s) => s.closed).length;
  const tape = f.tape ?? [];

  panel.innerHTML = `
    <div class="sus-head"><h4>Suspects</h4>${atLarge ? `<span class="sus-badge there">${atLarge} at large</span>` : ""}</div>
    <p class="sus-lede">${lede(f, list.length, atLarge, poi, closed)}</p>
    ${stale() ? `<p class="sus-lede">The map changed. Looking at the evidence again…</p>` : ""}
    ${tape.length ? tapeHtml(tape.length) : ""}
    <div class="sus-list">${list.map(poster).join("")}</div>
    ${residentsHtml(f)}
    <div class="sus-legend" aria-label="Map colours">
      <span><i style="background:var(--sus-3)"></i>At large</span>
      <span><i style="background:var(--sus-2)"></i>Just left</span>
      <span><i style="background:var(--sus-0)"></i>Long gone</span>
      <span><i style="background:var(--sus-unchecked)"></i>Not checked lately</span>
      <span><i style="background:var(--sus-closed)"></i>Case closed</span>
      <span><i class="resident"></i>Never reached</span>
      <span><i class="nodata"></i>Not enough runs</span>
    </div>
    <p class="fresh-note">${
      S.auth?.demo
        ? "Made-up history for the demo."
        : `Worked out from ${runs(f.counted ?? 0)} that finished with a map${f.skipped ? ` (${f.skipped} left out: no path, unfinished, only part of a room, or a room without enough runs yet)` : ""}.`
    }<br>Suspects are guesses from spots the robot couldn't reach, not things it saw.</p>`;

  updateTape(); // its label and buttons
  const input = $opt<HTMLInputElement>(".sus-name input", panel);
  if (input && justOpened) {
    justOpened = false;
    input.focus();
    input.select();
  }
}

function lede(f: Suspects, total: number, atLarge: number, poi: number, closed: number): string {
  if (!f.counted) {
    // Runs there may be; it's rooms with enough of them to compare that are missing.
    const need = f.min_runs ?? 10;
    const rooms = (f.rooms ?? []).filter((r) => r.judged > 0 && S.map?.rooms.some((x) => x.id === r.id));
    if (!rooms.length) return `No finished runs with a map yet. Every run the robot finishes while this app is running adds to the case.`;
    const so = rooms
      .sort((a, b) => b.judged - a.judged)
      .map((r) => `${esc(room(r.id))} ${r.judged}`)
      .join(", ");
    return `The case needs ${need} finished runs of a room to tell clutter from the robot's route. So far: ${so}.`;
  }
  if (!total) return `No suspects. Nothing has stood in the robot's way run after run. The floor is clean, or very good at hiding things.`;
  return [
    atLarge ? `<b>${atLarge}</b> at large` : `Nobody in the way right now`,
    `${total - poi} ${total - poi === 1 ? "suspect" : "suspects"}${poi ? `, ${poi} ${poi === 1 ? "person" : "people"} of interest` : ""} on file`,
    closed ? `${closed} ${closed === 1 ? "case" : "cases"} closed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function poster(s: Suspect): string {
  const k = key(s);
  const editing = naming === k;
  const name = editing
    ? `<form class="sus-name" data-name-form="${esc(k)}">
         <input type="text" maxlength="30" value="${esc(draft)}" placeholder="Laundry basket?" aria-label="Name for ${esc(title(s))}" autocomplete="off">
         <button class="btn-soft" type="submit">Save</button>
       </form>`
    : `<div class="sus-title">${esc(title(s))}${statusBadge(s)}</div>`;
  return `<article class="sus-poster${focus === k ? " focus" : ""}${s.closed ? " closed" : ""}${s.solid ? "" : " poi"}" data-poster="${esc(k)}">
    <span class="sus-num">${s.n}</span>
    <div class="sus-main">
      ${name}
      <div class="sus-facts">${esc(size(s))} · ${esc(room(s.room))} · ${area(s.area)}</div>
      <div class="sus-facts">In the way on ${s.blocked} of ${runs(s.of)} since · first ${esc(day(s.first))} · last ${esc(day(s.last))}</div>
      <p class="sus-quip">${quip(s)}</p>
      ${editing ? "" : `<div class="sus-acts"><button class="link-btn" data-rename="${esc(k)}">${s.name ? "Rename" : "Name this suspect"}</button>${s.name ? `<button class="link-btn" data-forget="${esc(k)}">Forget name</button>` : ""}</div>`}
    </div>
  </article>`;
}

function residentsHtml(f: Suspects): string {
  const residents = f.residents ?? [];
  if (!residents.length) return "";
  const total = residents.reduce((a, r) => a + r.area, 0);
  return `<details class="sus-residents"${residentsOpen ? " open" : ""}><summary>Permanent residents · ${residents.length} ${residents.length === 1 ? "spot" : "spots"}, ${area(total)}</summary>
    <p>Never reached on any finished run, in rooms that do get cleaned. Too settled to be suspects: under a table, between chair legs, behind the sofa.</p>
    <ul>${residents
      .slice()
      .sort((a, b) => b.area - a.area)
      .map((r) => `<li>${esc(room(r.room))} · ${area(r.area)} · ${runs(r.runs)}, never once</li>`)
      .join("")}</ul></details>`;
}

/* ---- the tape ---- */

// The slider's last stop is "all runs"; the ones before it are the runs, oldest first. It's
// drawn once with the panel and then only patched, so dragging it isn't interrupted.
function tapeHtml(count: number): string {
  return `<div class="sus-tape">
    <div class="sus-tape-row">
      <button class="sus-play" data-tape-play></button>
      <input type="range" min="0" max="${count}" step="1" value="${frame ?? count}" data-tape aria-label="Run on the tape">
      <button class="sus-play" data-tape-all aria-label="Back to all runs" title="All runs">${icon("x")}</button>
    </div>
    <div class="sus-tape-label"></div>
  </div>`;
}

function updateTape(): void {
  const tape = S.sus?.tape ?? [];
  const label = $opt(".sus-tape-label", panel);
  const range = $opt<HTMLInputElement>("[data-tape]", panel);
  const play = $opt<HTMLButtonElement>("[data-tape-play]", panel);
  const all = $opt<HTMLButtonElement>("[data-tape-all]", panel);
  if (!label || !range || !play || !all) return;
  const value = String(frame ?? tape.length);
  if (range.value !== value) range.value = value;
  play.innerHTML = icon(playing ? "pause" : "play");
  play.setAttribute("aria-label", playing ? "Pause the tape" : "Play the tape");
  play.title = playing ? "Pause" : "Play";
  all.hidden = frame == null;
  const at = frame != null ? tape[frame] : null;
  if (!at) {
    label.textContent = `All ${runs(tape.length)}. Press play to watch who came and went`;
    return;
  }
  const total = S.sus?.suspects?.length ?? 0;
  const seen = at.suspects.length ? `${at.suspects.map((n) => `#${n}`).join(", ")} in the way` : (at.clear ?? []).length === total && total ? "nothing in the way. Clearest floor" : "nobody in the way where it looked";
  label.textContent = `${when(at.at)} · ${seen}`;
}

/** Show one run of the tape (or all of them): the map, the tags and the tape itself. */
function setFrame(i: number | null): void {
  frame = i;
  if (S.viewMode !== "suspects") return;
  if (S.map) mapImg.src = suspectsImage();
  renderSuspectTags();
  updateTape();
}

function stop(): void {
  if (playing) clearInterval(playing);
  playing = null;
}

function play(): void {
  const tape = S.sus?.tape ?? [];
  if (!tape.length) return;
  if (playing) {
    stop();
    updateTape();
    return;
  }
  if (frame == null || frame >= tape.length - 1) frame = 0;
  playing = setInterval(() => {
    const n = S.sus?.tape?.length ?? 0;
    if (frame == null || frame >= n - 1 || S.viewMode !== "suspects") {
      stop();
      updateTape();
      return;
    }
    setFrame(frame + 1);
  }, 650);
  setFrame(frame);
}

/* ---- clicks, typing ---- */

panel.addEventListener("click", (e) => {
  if (closest(e.target, "[data-tape-play]")) return play();
  if (closest(e.target, "[data-tape-all]")) {
    stop();
    return setFrame(null);
  }
  const rename = closest(e.target, "[data-rename]");
  if (rename) {
    stop();
    naming = rename.dataset.rename ?? null;
    draft = byKey(naming)?.name ?? "";
    justOpened = true;
    return renderSusPanel();
  }
  const forget = closest(e.target, "[data-forget]");
  if (forget) return void saveName(forget.dataset.forget ?? "", "");
  if (closest(e.target, "form, input, button, details, summary, a")) return;
  const card = closest(e.target, "[data-poster]");
  if (card) setFocus(card.dataset.poster ?? null);
});

panel.addEventListener("input", (e) => {
  const range = closest<HTMLInputElement>(e.target, "[data-tape]");
  if (range) {
    stop();
    const i = Number(range.value);
    return setFrame(i >= (S.sus?.tape?.length ?? 0) ? null : i);
  }
  const name = closest<HTMLInputElement>(e.target, ".sus-name input");
  if (name) draft = name.value;
});

panel.addEventListener("toggle", (e) => {
  const d = closest<HTMLDetailsElement>(e.target, ".sus-residents");
  if (d) residentsOpen = d.open;
}, true);

panel.addEventListener("submit", (e) => {
  const form = closest<HTMLFormElement>(e.target, "[data-name-form]");
  if (!form) return;
  e.preventDefault();
  void saveName(form.dataset.nameForm ?? "", draft);
});

panel.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && naming != null) {
    naming = null;
    renderSusPanel();
  }
});

async function saveName(k: string, name: string): Promise<void> {
  const s = byKey(k);
  naming = null;
  if (!s || stale()) return renderSusPanel();
  const mine = gen;
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 30);
  try {
    const sus = await api<Suspects>(devicePath("suspects/name"), { method: "POST", body: { x: s.anchor[0], y: s.anchor[1], name: clean } });
    if (gen !== mine) return; // another robot was picked meanwhile
    toast(clean ? `#${s.n} is now "${clean}"` : `#${s.n} is nameless again`);
    await apply(sus);
  } catch (e) {
    toast(`Couldn't save the name: ${errorMessage(e)}`, true);
    renderSusPanel();
  }
}
