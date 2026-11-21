// The Settings tab.

import { runTimeline } from "./run-timeline";
import { parseTranscript, validTimelineLine } from "./app-timeline";
import type { AppTimeline } from "./app-timeline";
import { api, devicePath } from "./api";
import { $, $opt, closest, errorMessage, esc, fmtArea, fmtDuration, fmtWhen, human, icon, toast } from "./dom";
import { OPT_LABEL } from "./labels";
import { blockedNote, doAction, setSmartPlanShown, smartPlanShown } from "./panels";
import { S } from "./state";
import { notifyEnabled, notifySupported, setNotify } from "./notify";
import { themeChoice } from "./theme";
import type { Choice, DeviceTimelineStep, RunDetail, RunSummary, Settings } from "./types";
import { presets } from "./presets";

let runHistory: RunSummary[] = [];
let historyRequest = 0;
let fetchingHistoryMap = false;
let selectedRunId: string | null = null;
let selectedRun: RunDetail | null = null;
let runHistoryLoading = true;
let historyResultFilter: "all" | "completed" | "incomplete" = "all";
let historyTypeFilter: "all" | "vacuum" | "mopped" | "remopped" = "all";
let historySort: "newest" | "oldest" | "longest" | "largest" = "newest";
let routeProgress = 0;
let routeTimer: number | null = null;
let routeSpeed = 1;
let showVacuumRoute = true;
let showMopRoute = true;
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapDrag: { id: number; x: number; y: number; panX: number; panY: number } | null = null;

export async function loadRunHistory(): Promise<void> {
  runHistoryLoading = true;
  renderRunHistory();
  try {
    runHistory = await api<RunSummary[]>(devicePath("runs"));
  } catch (e) {
    toast(`Couldn't load run history: ${errorMessage(e)}`, true);
  } finally {
    runHistoryLoading = false;
  }
  renderRunHistory();
}

function routeSvg(run: RunDetail): string {
  if (!run.map || !run.route) return "";
  const lines = (items: number[][][], cls: string, group: string) => items.map((line, index) => {
    const points = line.map((p) => `${p[0]},${p[1]}`).join(" ");
    return line.length > 1 ? `<polyline class="replay-line ${cls}" data-route-line data-route-group="${group}" data-route-index="${index}" points="${points}" pathLength="1000"/>` : "";
  }).join("");
  const rooms = (run.map.rooms ?? []).map((room) => `<text class="run-room-label" x="${room.x}" y="${room.y}">${esc(room.name)}</text>`).join("");
  const charger = run.map.charger
    ? `<g class="run-charger" transform="translate(${run.map.charger.x} ${run.map.charger.y})"><circle r="9"/><text y="3.5">⌂</text></g>`
    : "";
  return `<div class="run-map" style="aspect-ratio:${run.map.width}/${run.map.height}">
    <div id="run-map-content" class="run-map-content">
      <img src="${run.map.base}" alt="Map for this cleaning run">
      <svg viewBox="0 0 ${run.map.width} ${run.map.height}" aria-label="Cleaning route">
        ${rooms}${charger}${lines(run.route.path, "clean", "clean")}${lines(run.route.mop_path, "mop", "mop")}
        <g id="run-playhead" class="run-playhead" visibility="hidden" aria-label="Robot">
          <circle class="robot-halo" r="23"/>
          <path class="robot-silhouette" d="M 0 -17 C 10 -17 17 -10 17 0 C 17 10 10 17 0 17 C -10 17 -17 10 -17 0 C -17 -10 -10 -17 0 -17 Z"/>
          <path class="robot-shell-line" d="M -12 -8 C -8 -14 8 -14 12 -8 M -14 5 C -9 13 9 13 14 5"/>
          <path class="robot-lid" d="M -7 -4 Q 0 -9 7 -4 L 8 5 Q 0 10 -8 5 Z"/>
          <circle class="robot-lidar" cy="-1" r="2.3"/>
          <path class="robot-bumper" d="M -11 -10 A 15 15 0 0 1 11 -10"/>
        </g>
      </svg>
    </div>
    <div class="run-route-legend" aria-label="Route legend">
      <button type="button" data-route-toggle="clean" aria-pressed="true"><i class="run-route-swatch vacuum"></i>Vacuum</button>
      <button type="button" data-route-toggle="mop" aria-pressed="true"><i class="run-route-swatch mop"></i>Mop</button>
    </div>
    <div class="run-map-tools" role="group" aria-label="Map zoom controls">
      <button class="btn-soft" data-map-zoom-in aria-label="Zoom in" title="Zoom in">+</button>
      <button class="btn-soft" data-map-zoom-out aria-label="Zoom out" title="Zoom out">−</button>
      <button class="btn-soft" data-map-zoom-reset title="Reset zoom">Reset</button>
      <span data-map-zoom-label>100%</span>
    </div>
  </div>`;
}

function routeMetrics(lines: number[][][]): { length: number; segments: Array<{ a: number[]; b: number[]; from: number; length: number }> } {
  let length = 0;
  const segments: Array<{ a: number[]; b: number[]; from: number; length: number }> = [];
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const size = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!Number.isFinite(size) || size <= 0) continue;
      segments.push({ a, b, from: length, length: size });
      length += size;
    }
  }
  return { length, segments };
}

function dockWaypoints(run: RunDetail): string {
  const dock = run.map?.charger;
  if (!dock || !run.route) return "";
  const route = routeMetrics(run.route.path);
  const stops: Array<{ distance: number; label: string }> = [];
  // Coordinates use four image pixels per 5 cm. Separate the arrival
  // and departure radii so small position changes near the dock stay quiet.
  let near: boolean | undefined;
  let previous: number[] | undefined;
  for (const segment of route.segments) {
    if (previous !== segment.a) {
      const start = Math.hypot(segment.a[0] - dock.x, segment.a[1] - dock.y);
      near = start <= 32 ? true : start >= 80 ? false : undefined;
    }
    previous = segment.b;
    const distance = Math.hypot(segment.b[0] - dock.x, segment.b[1] - dock.y);
    const next: boolean | undefined = distance <= 32 ? true : distance >= 80 ? false : near;
    if (near !== undefined && next !== near) {
      stops.push({ distance: segment.from + segment.length, label: next ? "Passed near the dock" : "Left the dock area" });
    }
    near = next;
  }
  if (!stops.length) return "";
  return `<details><summary>Dock area on the recorded route</summary><ol>${stops.map((stop) => {
    const progress = Math.round(stop.distance / route.length * 1000);
    return `<li><button class="btn-soft" data-waypoint="${progress}" aria-label="Show position at ${Math.round(progress / 10)}% of route">${Math.round(progress / 10)}%</button><span>${stop.label}</span></li>`;
  }).join("")}</ol></details>`;
}

function appTimelineKey(id: string): string {
  return `roborock:app-timeline:${S.duid}:${id}`;
}

function readAppTimeline(id: string): { text: string; transcript?: AppTimeline } {
  try {
    const saved = localStorage.getItem(appTimelineKey(id)) ?? "";
    if (!saved.startsWith("{")) return { text: saved };
    const transcript = parseTranscript(saved, id);
    return { text: transcript.events.join("\n"), transcript };
  } catch { return { text: "" }; }
}

function cleanInfo(clean: DeviceTimelineStep["clean"]): string {
  if (!clean) return "";
  const cells: string[] = [];
  if (clean.clean_mode != null) cells.push(`<span title="Suction mode ${clean.clean_mode}">${icon("fan")}</span>`);
  if (clean.mode !== "Vacuum" && clean.water_mode != null) {
    cells.push(`<span title="Water mode ${clean.water_mode}">${icon("drop")}${clean.mop_power != null ? `<em>${clean.mop_power}</em>` : ""}</span>`);
  }
  if (clean.mop_mode != null || clean.mop_type != null) {
    cells.push(`<span title="Mop mode ${clean.mop_mode ?? ""}${clean.mop_type != null ? `, mop type ${clean.mop_type}` : ""}">${icon("sliders")}</span>`);
  }
  if (clean.repeat_count != null) cells.push(`<span>×${clean.repeat_count}</span>`);
  return cells.join('<i aria-hidden="true"></i>');
}

function timelineRow(time: string, label: string, details: string[], major: boolean, fromApp: boolean, clean?: DeviceTimelineStep["clean"]): string {
  const clock = `<time>${esc(time)}</time>`;
  let body = "";
  if (details.length) {
    const lines = details.map(d => esc(d));
    if (!major) body = `<div class="rr-detail">${lines.join(" | ")}</div>`;
    else if (label.startsWith("Start ")) body = `<ul class="rr-detail rr-plan">${lines.map(d => `<li>${d}</li>`).join("")}</ul>`;
    else if (fromApp && label === "Automatic Re-Mopping") body = `<div class="rr-detail rr-ai"><b>AI</b><div>${lines.join(" · ")}</div></div>`;
    else {
      const modeIcon = details[0] === "Vacuum" ? "fan" : details[0].includes("Mop") ? "drop" : null;
      const options = clean ? cleanInfo(clean) : lines.slice(1).join(" | ");
      body = `<div class="rr-detail"><div>${lines[0]}</div>${modeIcon || options ? `<small class="rr-options">${clean ? options : `${modeIcon ? icon(modeIcon) : ""}${modeIcon && options ? " | " : ""}${options}`}</small>` : ""}</div>`;
    }
  }
  return `<li class="rr-step ${major ? "rr-major" : "rr-minor"}">
    <div class="rr-clock">${major ? clock : ""}</div><div class="rr-rail" aria-hidden="true"><i>${major ? "✓" : ""}</i></div>
    <div class="rr-event"><span>${esc(label)}</span>${body}${major ? "" : clock}</div>
  </li>`;
}

function isMilestone(label: string): boolean {
  return /^(Start |Clean |Cleaning Finished$|Automatic Re-Mopping$)/i.test(label);
}

function appTimelineRows(value: string): string {
  return value.split("\n").map((line) => {
    const match = /^(\d\d:\d\d)\s+(.+)$/.exec(line);
    if (!match) return "";
    const [label, ...details] = match[2].split(" | ");
    const major = isMilestone(label);
    return timelineRow(match[1], label, major || !details.length ? details : [details.join(" | ")], major, true);
  }).join("");
}

function runDetailHtml(): string {
  if (!selectedRunId) return "";
  if (!selectedRun) return `<section class="run-detail"><div class="history-head"><b>Cleaning run</b><button class="btn-soft" data-run-close>Close</button></div><p class="muted">Loading run details…</p></section>`;
  const run = selectedRun;
  const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const duration = run.duration ?? Math.max(0, run.end - run.begin);
  const elapsed = Math.max(0, run.end - run.begin);
  const overhead = Math.max(0, elapsed - duration);
  const result = run.complete === true ? "Completed" : run.complete === false ? "Stopped before completion" : "Result not reported";
  const mode = run.mode?.replaceAll("_", " ") ?? null;
  const startType = run.start_type?.replaceAll("_", " ") ?? null;
  const { text: appTimeline, transcript } = readAppTimeline(run.id);
  const useTranscript = !!appTimeline && !run.device_timeline?.length;
  const extra = run.record_details;
  const area = useTranscript && transcript ? `${transcript.area_m2} m²` :
    extra?.cleaned_area != null ? `${Math.round(extra.cleaned_area)} m²` : fmtArea(run.area);
  const emptyings = run.device_timeline?.filter(step => step.label === "Auto Emptying").length;
  const subtitle = (useTranscript && transcript ? transcript.summary : undefined) ?? [
    startType ? human(startType) : null, extra?.rooms || run.device_timeline?.some(step => step.label === "Start selective room cleaning") ? "Rooms" : null,
    emptyings ? `Dust collection × ${emptyings}` : run.dust_collected ? "Dust collected" : null,
    run.wash_count ? `Mop wash × ${run.wash_count}` : null,
  ].filter(Boolean).join(" · ");
  const recordedEvents = run.events ?? [];
  const timeline = runTimeline(run, result);
  const untimed = timeline.filter(event => event.at === null);
  const stats = [fmtDuration(duration), area, mode,
    run.wash_count != null ? `${run.wash_count} mop washes` : null,
    run.dust_collected ? "Dust collected" : null,
    run.avoid_count != null ? `${run.avoid_count} avoidance events` : null]
    .filter((x): x is string => !!x).map((x) => `<span>${esc(x)}</span>`).join("");
  return `<section class="run-detail">
    <div class="history-head"><b>${esc(fmtWhen(run.begin))}</b><button class="btn-soft" data-run-close>Close</button></div>
    <div class="run-time-breakdown">
      <span><strong>${esc(fmtDuration(duration))}</strong><small>Cleaning time</small></span>
      <span><strong>${esc(fmtDuration(elapsed))}</strong><small>Total elapsed</small></span>
      <span><strong>${esc(fmtDuration(overhead))}</strong><small>Dock &amp; other</small></span>
      <span><strong>${esc(area)}</strong><small>Cleaning area</small></span>
    </div>
    ${overhead > 0 ? `<p class="run-time-note">Total elapsed also includes travel, mop washing, emptying and other dock activity.</p>` : ""}
    <div class="run-stats">${stats}<span>${esc(result)}</span></div>
    ${run.route && run.map ? `${routeSvg(run)}
      <div class="replay-controls">
        <button class="btn-soft" data-run-play aria-label="Play route">${icon("play")}<span>Play route</span></button>
        <div class="replay-speeds" role="group" aria-label="Replay speed">
          ${[1, 3, 5].map((speed) => `<button class="btn-soft replay-speed${routeSpeed === speed ? " is-active" : ""}" data-run-speed="${speed}" aria-pressed="${routeSpeed === speed}">${speed}×</button>`).join("")}
        </div>
        <label class="visually-hidden" for="run-progress">Route progress</label>
        <input id="run-progress" type="range" min="0" max="1000" value="${routeProgress}">
        <span id="run-progress-label">${fmtDuration(0)} / ${fmtDuration(duration)}</span>
        <b id="run-replay-phase" class="run-replay-phase">Vacuuming</b>
      </div>
      <p class="run-disclaimer">The robot follows its saved route once. Mop coverage appears along that route. Roborock doesn't provide timestamps for individual path points, so replay timing is approximate.</p>`
      : `<div class="run-no-route">${fetchingHistoryMap ? 'Loading the map for this run…' : 'No saved route available for this run.'}</div>`}
    <section class="rr-timeline"><details open>
      <summary><strong>${run.complete === true ? '<span class="rr-done" aria-hidden="true">✓</span>Finished cleaning' : esc(result)}</strong><span class="rr-disclosure" aria-hidden="true"></span>
      <small>${esc(subtitle)}</small></summary>
      <div class="rr-scroll" tabindex="0" role="region" aria-label="Cleaning timeline"><ol>${useTranscript ? appTimelineRows(appTimeline) : timeline.flatMap(event => {
        if (event.at === null) return [];
        const time = (event.approximate ? "≈ " : "") + clock(event.at);
        return timelineRow(time, event.label, event.detail ? event.detail.split(" · ") : [], isMilestone(event.label), !!run.device_timeline?.length, event.clean);
      }).join("")}</ol>
      ${!useTranscript && untimed.length ? `<section class="rr-untimed"><strong>Reported without a time</strong><ul>${untimed.map(event =>
        `<li>${esc(event.label)}${event.detail ? ` · ${esc(event.detail)}` : ""}</li>`
      ).join("")}</ul></section>` : ""}
      </div></details>
      <footer><span><strong>${Math.round(duration / 60)}</strong> min<small>Cleaning Time</small></span><span><strong>${esc(area.split(" ")[0])}</strong>${area.endsWith(" m²") ? " m²" : ""}<small>Cleaning Area</small></span></footer>
    </section>
    <p class="run-disclaimer">${useTranscript ? "Transcribed from the Roborock app." : run.device_timeline?.length ? "Detailed timeline received from the robot — the same event source used by Roborock’s history." : recordedEvents.length ? "Temporary observed timeline. Roborock Web is still trying to retrieve the robot’s complete event list." : "No detailed events were available for this run."}</p>
    ${dockWaypoints(run)}
    <details><summary>Edit app timeline</summary><label>One event per line: HH:MM Event | Detail<br><textarea data-app-timeline rows="8" style="width:100%" maxlength="20000">${esc(appTimeline)}</textarea></label><button class="btn-soft" data-save-timeline>Save for this run</button><label>Import a transcript for this run <input type="file" accept=".json,application/json" data-import-timeline></label><small>Saved in this browser.</small></details>
    ${run.source === "demo" ? "" : `<a class="btn-soft run-source-data" href="${esc(devicePath(`runs/${encodeURIComponent(run.id)}/diagnostics`))}">Download raw run data for timeline analysis</a>`}
    <p class="run-disclaimer">The export includes the saved map and may reveal your home's floorplan. Share it only if you are comfortable with that.</p>
  </section>`;
}

function syncRouteProgress(): void {
  const card = document.querySelector<HTMLElement>("#history-runs");
  const range = card?.querySelector<HTMLInputElement>("#run-progress");
  if (!card || !range) return;
  const progress = Number(range.value) / 1000;
  if (selectedRun?.route) {
    const clean = routeMetrics(selectedRun.route.path);
    const route = clean;
    const targetDistance = progress * clean.length;
    const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
    // Mop lines are contiguous slices of the travel path. Locate each slice
    // in order so repeated visits to the same coordinate stay distinct.
    let offset = 0;
    let mopIndex = 0;
    let mopping = false;
    const draw = (group: string, index: number, start: number, length: number, visible: boolean) => {
      const line = card.querySelector<SVGPolylineElement>(`[data-route-group="${group}"][data-route-index="${index}"]`);
      if (!line) return;
      const fraction = Math.max(0, Math.min(1, (targetDistance - start) / (length || 1)));
      line.style.strokeDasharray = `${fraction * 1000} 1000`;
      line.style.visibility = visible && fraction > 0 ? "visible" : "hidden";
    };
    const mopLines = selectedRun.route.mop_path;
    for (const [index, points] of selectedRun.route.path.entries()) {
      const lengths = [0];
      for (let i = 1; i < points.length; i++) {
        lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i-1][0], points[i][1] - points[i-1][1]));
      }
      const length = lengths[lengths.length - 1];
      draw("clean", index, offset, length, showVacuumRoute);
      for (let i = 0; i < points.length && mopIndex < mopLines.length; i++) {
        const mop = mopLines[mopIndex];
        if (!mop.length || i + mop.length > points.length || !mop.every((p, j) => same(p, points[i+j]))) continue;
        const start = offset + lengths[i];
        const end = offset + lengths[i + mop.length - 1];
        draw("mop", mopIndex++, start, end - start, showMopRoute);
        if (targetDistance >= start && targetDistance < end) mopping = true;
        i += mop.length - 1;
      }
      offset += length;
    }
    for (; mopIndex < mopLines.length; mopIndex++) draw("mop", mopIndex, 0, 1, progress === 1 && showMopRoute);
    const playhead = card.querySelector<SVGGElement>("#run-playhead");
    if (playhead && route.length > 0) {
      const target = Math.min(route.length, progress * route.length);
      const seg = route.segments.find((s) => target <= s.from + s.length) ?? route.segments[route.segments.length - 1];
      const local = Math.max(0, Math.min(1, (target - seg.from) / seg.length));
      const x = seg.a[0] + (seg.b[0] - seg.a[0]) * local;
      const y = seg.a[1] + (seg.b[1] - seg.a[1]) * local;
      const angle = Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]) * 180 / Math.PI + 90;
      playhead.setAttribute("transform", `translate(${x} ${y}) rotate(${angle})`);
      playhead.setAttribute("visibility", progress > 0 ? "visible" : "hidden");
    }
    const phase = card.querySelector<HTMLElement>("#run-replay-phase");
    if (phase) {
      phase.textContent = mopping ? "Mop coverage" : "Travel path";
      phase.classList.toggle("is-mopping", mopping);
    }
    playhead?.classList.toggle("is-mopping", mopping);
  }
  const label = card.querySelector<HTMLElement>("#run-progress-label");
  if (selectedRun && label) {
    const duration = selectedRun.duration ?? (selectedRun.end - selectedRun.begin);
    label.textContent = `${fmtDuration(Math.round(duration * progress))} / ${fmtDuration(duration)}`;
  }
}

function applyMapView(): void {
  const map = settingsRoot.querySelector<HTMLElement>(".run-map");
  const content = map?.querySelector<HTMLElement>("#run-map-content");
  if (!map || !content) return;
  const maxX = (map.clientWidth * (mapZoom - 1)) / 2;
  const maxY = (map.clientHeight * (mapZoom - 1)) / 2;
  mapPanX = Math.max(-maxX, Math.min(maxX, mapPanX));
  mapPanY = Math.max(-maxY, Math.min(maxY, mapPanY));
  content.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
  map.classList.toggle("is-zoomed", mapZoom > 1);
  const label = map.querySelector<HTMLElement>("[data-map-zoom-label]");
  if (label) label.textContent = `${Math.round(mapZoom * 100)}%`;
}

function zoomMap(direction: 1 | -1): void {
  mapZoom = Math.max(1, Math.min(5, mapZoom * (direction > 0 ? 1.25 : 0.8)));
  if (mapZoom === 1) { mapPanX = 0; mapPanY = 0; }
  applyMapView();
}

function syncSpeedButtons(): void {
  settingsRoot.querySelectorAll<HTMLButtonElement>("[data-run-speed]").forEach((button) => {
    const active = Number(button.dataset.runSpeed) === routeSpeed;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderRunHistory(): void {
  const list = $opt<HTMLElement>("#history-runs-list");
  const detail = $opt<HTMLElement>("#history-run-detail");
  if (!list || !detail) return;
  list.hidden = selectedRunId !== null;
  detail.hidden = selectedRunId === null;
  const filteredRuns = runHistory.filter((run) => {
    if (historyResultFilter === "completed" && run.complete !== true) return false;
    if (historyResultFilter === "incomplete" && run.complete !== false) return false;
    if (historyTypeFilter === "vacuum" && run.mopped) return false;
    if (historyTypeFilter === "mopped" && !run.mopped) return false;
    if (historyTypeFilter === "remopped" && !run.remopped) return false;
    return true;
  }).sort((a, b) => {
    if (historySort === "oldest") return a.begin - b.begin;
    if (historySort === "longest") return (b.duration ?? 0) - (a.duration ?? 0);
    if (historySort === "largest") return (b.area ?? 0) - (a.area ?? 0);
    return b.begin - a.begin;
  });
  list.innerHTML = selectedRunId ? "" : runHistory.length
    ? `<div class="history-runs-head"><div class="history-runs-label">Recent runs <small>${filteredRuns.length} of ${runHistory.length}</small></div>
      <div class="history-run-filters">
        <label>Result<select data-history-result><option value="all"${historyResultFilter === "all" ? " selected" : ""}>All</option><option value="completed"${historyResultFilter === "completed" ? " selected" : ""}>Completed</option><option value="incomplete"${historyResultFilter === "incomplete" ? " selected" : ""}>Stopped</option></select></label>
        <label>Cleaning<select data-history-type><option value="all"${historyTypeFilter === "all" ? " selected" : ""}>All</option><option value="vacuum"${historyTypeFilter === "vacuum" ? " selected" : ""}>Vacuum only</option><option value="mopped"${historyTypeFilter === "mopped" ? " selected" : ""}>Mopped</option><option value="remopped"${historyTypeFilter === "remopped" ? " selected" : ""}>Re-mopped</option></select></label>
        <label>Sort<select data-history-sort><option value="newest"${historySort === "newest" ? " selected" : ""}>Newest</option><option value="oldest"${historySort === "oldest" ? " selected" : ""}>Oldest</option><option value="longest"${historySort === "longest" ? " selected" : ""}>Longest</option><option value="largest"${historySort === "largest" ? " selected" : ""}>Largest area</option></select></label>
      </div></div>${filteredRuns.length ? `<ul class="history-runs-list">${filteredRuns.map((run) => {
      const mode = run.mode?.replaceAll("_", " ");
      const badges = [
        run.complete === false ? "Stopped" : null,
        run.remopped ? "Re-mopped" : run.mopped ? "Mopped" : "Vacuum",
        run.empty_count ? `Emptied ×${run.empty_count}` : run.dust_collected ? "Dust collected" : null,
        run.wash_count ? `Mop wash ×${run.wash_count}` : null,
      ].filter((value): value is string => !!value);
      return `<li class="history-run-item"><button class="run-open" data-run="${esc(run.id)}"><span class="run-when">${esc(fmtWhen(run.begin))}</span>
        <span class="run-what">${fmtDuration(run.duration)} · ${fmtArea(run.area)}${mode ? ` · ${esc(mode)}` : ""}${run.mopped ? " · mopped" : ""}</span>
        <span class="run-badges">${badges.map(badge => `<i>${esc(badge)}</i>`).join("")}</span>
        <span class="run-route-note">${run.mapped ? "Route available · open replay" : run.source !== "demo" ? "Open to load route map" : "Summary only"}</span></button>
        <button class="run-delete" data-run-delete="${esc(run.id)}" aria-label="Delete cleaning run" title="Delete run">${icon("trash")}</button></li>`;
    }).join("")}</ul>` : `<p class="muted history-filter-empty">No runs match these filters.</p>`}`
    : `<p class="muted">${runHistoryLoading ? "Loading run history…" : "No recent runs available."}</p>`;
  detail.innerHTML = runDetailHtml();
  syncRouteProgress();
  syncSpeedButtons();
  syncRouteToggles();
  applyMapView();
}

function syncRouteToggles(): void {
  settingsRoot.querySelectorAll<HTMLButtonElement>("[data-route-toggle]").forEach((button) => {
    const visible = button.dataset.routeToggle === "clean" ? showVacuumRoute : showMopRoute;
    button.setAttribute("aria-pressed", String(visible));
    button.classList.toggle("is-off", !visible);
  });
}

async function openHistoryRun(id: string): Promise<void> {
  if (routeTimer != null) window.clearInterval(routeTimer);
  routeTimer = null;
  selectedRunId = id;
  selectedRun = null;
  runHistoryLoading = true;
  routeProgress = 0;
  routeSpeed = 1;
  showVacuumRoute = true;
  showMopRoute = true;
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
  renderRunHistory();
  const request = ++historyRequest;
  const current = () => request === historyRequest && selectedRunId === id;
  const path = devicePath(`runs/${encodeURIComponent(id)}`);
  fetchingHistoryMap = false;
  try {
    const cached = await api<RunDetail>(path + "?cached=true");
    if (!current()) return;
    selectedRun = cached;
    const needsMap = !cached.route || !cached.map;
    if ((needsMap || cached.record_details == null || cached.needs_timeline) && cached.source !== "demo") {
      fetchingHistoryMap = needsMap;
      renderRunHistory();
      const refreshed = await api<RunDetail>(path);
      if (!current()) return;
      selectedRun = refreshed;
    }
  } catch (e) {
    if (current()) {
      toast(`Couldn't load run details: ${errorMessage(e)}`, true);
      if (!selectedRun) selectedRunId = null;
    }
  } finally {
    if (request === historyRequest) {
      fetchingHistoryMap = false;
      runHistoryLoading = false;
      if (current() && selectedRun) {
        runHistory = runHistory.map((run) => run.id === id
          ? { ...run, mapped: Boolean(selectedRun?.route && selectedRun?.map) }
          : run);
      }
      renderRunHistory();
    }
  }
}

const settingsRoot = $("#settings");
settingsRoot.addEventListener("change", async (event) => {
  const input = event.target;
  if (input instanceof HTMLSelectElement && input.matches("[data-history-result]")) {
    historyResultFilter = input.value as typeof historyResultFilter;
    renderRunHistory();
    return;
  }
  if (input instanceof HTMLSelectElement && input.matches("[data-history-type]")) {
    historyTypeFilter = input.value as typeof historyTypeFilter;
    renderRunHistory();
    return;
  }
  if (input instanceof HTMLSelectElement && input.matches("[data-history-sort]")) {
    historySort = input.value as typeof historySort;
    renderRunHistory();
    return;
  }
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-import-timeline]") || !selectedRun) return;
  const file = input.files?.[0];
  if (!file) return;
  const runId = selectedRun.id;
  const key = appTimelineKey(runId);
  try {
    if (file.size > 150000) throw new Error("This timeline file is too large.");
    const transcript = parseTranscript(await file.text(), runId);
    if (selectedRun?.id !== runId || key !== appTimelineKey(runId)) return;
    localStorage.setItem(key, JSON.stringify(transcript));
    renderRunHistory();
    toast("App timeline imported.");
  } catch (error) {
    toast(errorMessage(error), true);
    input.value = "";
  }
});
settingsRoot.addEventListener("click", async (e) => {
  if (closest(e.target, "[data-save-timeline]") && selectedRun) {
    const value = settingsRoot.querySelector<HTMLTextAreaElement>("[data-app-timeline]")?.value.trim() ?? "";
    if (value && value.split("\n").some((line) => !validTimelineLine(line))) {
      toast("Start each event with HH:MM and its name.", true);
      return;
    }
    try {
      const key = appTimelineKey(selectedRun.id);
      const { transcript } = readAppTimeline(selectedRun.id);
      if (value) localStorage.setItem(key, transcript ? JSON.stringify({ ...transcript, events: value.split("\n") }) : value);
      else localStorage.removeItem(key);
    } catch { toast("Could not save this timeline in the browser.", true); return; }
    renderRunHistory();
    return;
  }
  const waypoint = closest<HTMLButtonElement>(e.target, "[data-waypoint]");
  if (waypoint) {
    routeProgress = Number(waypoint.dataset.waypoint);
    const slider = settingsRoot.querySelector<HTMLInputElement>("#run-progress");
    if (slider) slider.value = String(routeProgress);
    syncRouteProgress();
    return;
  }
  const close = closest(e.target, "[data-run-close]");
  if (close) {
    if (routeTimer != null) window.clearInterval(routeTimer);
    routeTimer = null;
    selectedRunId = null;
    selectedRun = null;
    renderRunHistory();
    return;
  }
  const deleteButton = closest<HTMLButtonElement>(e.target, "[data-run-delete]");
  if (deleteButton) {
    const id = deleteButton.dataset.runDelete ?? "";
    const run = runHistory.find((item) => item.id === id);
    const target = run?.source === "demo" ? "the demo history" : "the robot and this app";
    if (!run || !confirm(`Delete the cleaning run from ${fmtWhen(run.begin)} from ${target}? This cannot be undone.`)) return;
    deleteButton.disabled = true;
    try {
      await api<void>(devicePath(`runs/${encodeURIComponent(id)}`), { method: "DELETE" });
      if (routeTimer != null) window.clearInterval(routeTimer);
      routeTimer = null;
      if (selectedRunId === id) {
        selectedRunId = null;
        selectedRun = null;
      }
      runHistory = runHistory.filter((item) => item.id !== id);
      renderRunHistory();
      toast("Cleaning run deleted");
      void loadSettings();
    } catch (error) {
      deleteButton.disabled = false;
      toast(`Couldn't delete this run: ${errorMessage(error)}`, true);
    }
    return;
  }
  const speed = closest<HTMLButtonElement>(e.target, "[data-run-speed]");
  if (speed) {
    routeSpeed = Number(speed.dataset.runSpeed) || 1;
    syncSpeedButtons();
    return;
  }
  const routeToggle = closest<HTMLButtonElement>(e.target, "[data-route-toggle]");
  if (routeToggle) {
    if (routeToggle.dataset.routeToggle === "clean") showVacuumRoute = !showVacuumRoute;
    if (routeToggle.dataset.routeToggle === "mop") showMopRoute = !showMopRoute;
    syncRouteProgress();
    syncRouteToggles();
    return;
  }
  if (closest(e.target, "[data-map-zoom-in]")) { zoomMap(1); return; }
  if (closest(e.target, "[data-map-zoom-out]")) { zoomMap(-1); return; }
  if (closest(e.target, "[data-map-zoom-reset]")) {
    mapZoom = 1; mapPanX = 0; mapPanY = 0; applyMapView(); return;
  }
  const run = closest<HTMLButtonElement>(e.target, "[data-run]");
  if (run) { await openHistoryRun(run.dataset.run ?? ""); return; }
  const play = closest<HTMLButtonElement>(e.target, "[data-run-play]");
  if (!play) return;
  if (routeTimer != null) {
    window.clearInterval(routeTimer);
    routeTimer = null;
    play.querySelector("span")!.textContent = "Play route";
    play.setAttribute("aria-label", "Play route");
    return;
  }
  if (routeProgress >= 1000) routeProgress = 0;
  play.querySelector("span")!.textContent = "Pause";
  play.setAttribute("aria-label", "Pause replay");
  const range = settingsRoot.querySelector<HTMLInputElement>("#run-progress");
  if (range) range.value = String(routeProgress);
  syncRouteProgress();
  routeTimer = window.setInterval(() => {
    routeProgress = Math.min(1000, routeProgress + (50 * routeSpeed * 1000) / 60_000);
    const slider = settingsRoot.querySelector<HTMLInputElement>("#run-progress");
    if (slider) slider.value = String(routeProgress);
    syncRouteProgress();
    if (routeProgress >= 1000) {
      if (routeTimer != null) window.clearInterval(routeTimer);
      routeTimer = null;
      const label = settingsRoot.querySelector<HTMLElement>("[data-run-play] span");
      if (label) label.textContent = "Play route";
      settingsRoot.querySelector<HTMLButtonElement>("[data-run-play]")?.setAttribute("aria-label", "Play route");
    }
  }, 50);
});

settingsRoot.addEventListener("pointerdown", (e) => {
  if (mapZoom <= 1 || closest(e.target, ".run-map-tools") || closest(e.target, ".run-route-legend")) return;
  const map = closest<HTMLElement>(e.target, ".run-map");
  if (!map) return;
  mapDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: mapPanX, panY: mapPanY };
  map.setPointerCapture(e.pointerId);
  map.classList.add("is-panning");
});

settingsRoot.addEventListener("pointermove", (e) => {
  if (!mapDrag || mapDrag.id !== e.pointerId) return;
  mapPanX = mapDrag.panX + e.clientX - mapDrag.x;
  mapPanY = mapDrag.panY + e.clientY - mapDrag.y;
  applyMapView();
});

function stopMapDrag(e: PointerEvent): void {
  if (!mapDrag || mapDrag.id !== e.pointerId) return;
  settingsRoot.querySelector(".run-map")?.classList.remove("is-panning");
  mapDrag = null;
}

settingsRoot.addEventListener("pointerup", stopMapDrag);
settingsRoot.addEventListener("pointercancel", stopMapDrag);

settingsRoot.addEventListener("wheel", (e) => {
  if (!closest(e.target, ".run-map")) return;
  if ((e.deltaY > 0 && mapZoom <= 1) || (e.deltaY < 0 && mapZoom >= 5)) return;
  e.preventDefault();
  zoomMap(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

settingsRoot.addEventListener("input", (e) => {
  const range = closest<HTMLInputElement>(e.target, "#run-progress");
  if (!range) return;
  routeProgress = Number(range.value);
  syncRouteProgress();
});

document.addEventListener("run-history-refresh", () => {
  if (S.tab === "settings") void loadRunHistory();
});

export async function loadSettings(): Promise<void> {
  const el = $("#settings");
  if (!S.settings) {
    el.innerHTML = [1, 2, 3, 4]
      .map(() => `<div class="card"><div class="skel" style="height:18px;width:40%"></div><div class="skel" style="height:40px;margin-top:18px"></div><div class="skel" style="height:40px;margin-top:12px"></div></div>`)
      .join("");
  }
  try {
    S.settings = await api<Settings>(devicePath("settings"));
    renderSettings();
    void loadRunHistory();
  } catch (e) {
    el.innerHTML = `<div class="card">Couldn't load settings.<br><span class="muted">${esc(errorMessage(e))}</span></div>`;
  }
}

function connectionText(): string {
  const l = S.status?.links;
  if (!l) return S.status?.connected === false ? "Offline" : S.status?.local ? "Local network" : "Roborock cloud";
  const ways = [l.local ? `Home network${l.ip ? ` (${esc(l.ip)})` : ""}` : "", l.cloud ? "Roborock cloud" : ""].filter(Boolean);
  return ways.length ? ways.join(" and ") : "Offline";
}

const sw = (action: string, on: boolean | null | undefined) =>
  `<label class="switch"><input type="checkbox" data-switch="${action}" ${on ? "checked" : ""}><span></span></label>`;

const row = (iconName: string, title: string, sub: string | null, control: string) =>
  `<div class="row"><div class="row-main"><span class="row-icon">${icon(iconName)}</span><div><div class="row-title">${title}</div>${sub ? `<div class="row-sub">${sub}</div>` : ""}</div></div>${control}</div>`;

const choice = (action: string, opt: Choice) =>
  `<div class="seg small" style="margin-top:10px">${opt.options.map((o) => `<button data-choice="${action}" data-value="${esc(o)}" class="${o === opt.value ? "active" : ""}">${esc(OPT_LABEL[o] || human(o))}</button>`).join("")}</div>`;

export function renderSettings(): void {
  const s = S.settings;
  if (!s) return;
  const cards: string[] = [];
  const offline = s.connected === false || S.status?.connected === false;
  if (offline) {
    cards.push(`<div class="card offline-card"><div class="card-head"><h3 class="card-title">${icon("wifi")}Can't reach your robot</h3></div>
      <p class="muted">Sound, do not disturb, dock and maintenance settings are read from the robot itself, so they'll be back here as soon as it's online again. Check that it's switched on and connected to Wi‑Fi.</p>
      <button class="btn-soft" data-act="reconnect" style="margin-top:14px">Reconnect</button></div>`);
  }

  // Robot
  let robot = "";
  if (s.volume != null) {
    robot += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("volume")}</span><div class="row-title">Voice volume</div></div>
      <div class="range-row"><input type="range" min="0" max="100" step="5" value="${s.volume}" id="vol"><output id="vol-out">${s.volume}</output>
      <button class="btn-soft" data-act="test_volume">Test</button></div></div>`;
  }
  if (s.child_lock != null) robot += row("lock", "Child lock", "Disables the buttons on the robot", sw("set_child_lock", s.child_lock));
  if (s.led != null) robot += row("light", "Status light", "The light ring on the robot", sw("set_led", s.led));
  if (s.flow_led != null) robot += row("light", "Light strip", null, sw("set_flow_led", s.flow_led));
  if (s.carpet_boost != null) robot += row("layers", "Carpet boost", "More suction when it detects carpet", sw("set_carpet_boost", s.carpet_boost));
  if (robot) cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("robot")}Robot</h3></div>${robot}</div>`);

  // Do not disturb
  if (s.dnd) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("moon")}Do not disturb</h3>${sw("dnd", s.dnd.enabled)}</div>
      <div class="note" style="margin:0">No cleaning, voice or auto-empty during these hours.</div>
      <div class="time-row"><label>From<input type="time" id="dnd-start" value="${esc(s.dnd.start)}"></label><label>Until<input type="time" id="dnd-end" value="${esc(s.dnd.end)}"></label></div></div>`);
  }

  // Dock
  let dock = "";
  if (s.dust_mode) dock += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("trash")}</span><div><div class="row-title">Auto-empty</div><div class="row-sub">How hard the dock empties the dust bin</div></div></div>${choice("set_dust_mode", s.dust_mode)}</div>`;
  if (s.wash_mode) dock += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("waves")}</span><div><div class="row-title">Mop washing</div><div class="row-sub">How thoroughly the dock washes the mop</div></div></div>${choice("set_wash_mode", s.wash_mode)}</div>`;
  if (s.smart_wash) dock += row("spark", "Smart mop washing", "Let the robot decide when to rewash", sw("set_smart_wash", s.smart_wash.enabled));
  if (s.mop_dryer) {
    const h = s.mop_dryer.dry_time ? ` · ${Math.round(s.mop_dryer.dry_time / 3600)} h` : "";
    dock += row("sun", "Auto mop drying", `Dry the mop with warm air after washing${h}`, sw("set_mop_dryer", s.mop_dryer.enabled));
  }
  if (dock) cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("dock")}Dock</h3></div>${dock}</div>`);

  // Maintenance
  if (s.consumables?.length) {
    const items = s.consumables
      .map((c) => {
        const left = c.unit === "s" ? `${Math.round(c.left / 3600)} h left` : `${c.left} uses left`;
        const cls = c.percent < 10 ? "low" : c.percent < 30 ? "mid" : "";
        return `<div class="cons"><div class="cons-top"><b>${esc(c.name)}</b><span>${left} · ${c.percent}%<button data-reset="${esc(c.key)}" data-name="${esc(c.name)}">Reset</button></span></div><div class="bar ${cls}"><i style="width:${c.percent}%"></i></div></div>`;
      })
      .join("");
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("wrench")}Maintenance</h3></div>${items}<div class="note">Reset after you clean or replace a part.</div></div>`);
  }

  // Routines
  if (s.routines?.length) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("play")}Routines</h3></div>
      ${s.routines.map((r) => row("spark", esc(r.name), null, `<button class="btn-soft" data-routine="${r.id}">${icon("play")}Run</button>`)).join("")}</div>`);
  }

  const saved = presets();
  if (saved.zones.length || saved.plans.length) {
    const savedRow = (kind: "zone" | "plan", id: string, name: string, sub: string) =>
      row(kind === "zone" ? "zone" : "spark", esc(name), sub,
        `<button class="run-delete" data-delete-preset="${esc(id)}" data-preset-kind="${kind}" aria-label="Delete ${esc(name)}">${icon("trash")}</button>`);
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("spark")}Saved cleaning</h3></div>
      ${saved.plans.map((p) => savedRow("plan", p.id, p.name, `${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"} · ${p.repeat}×`)).join("")}
      ${saved.zones.map((z) => savedRow("zone", z.id, z.name, "Saved map zone")).join("")}
      <div class="note">Create plans after selecting rooms, or save a zone after drawing it on the map.</div></div>`);
  }

  // History
  {
    const sm = s.summary;
    let hist = sm ? `<div class="big-stats">
      <div class="stat"><b>${sm.total_time != null ? Math.round(sm.total_time / 3600) + " h" : "–"}</b><span>Total time</span></div>
      <div class="stat"><b>${fmtArea(sm.total_area)}</b><span>Total area</span></div>
      <div class="stat"><b>${sm.count ?? "–"}</b><span>Cleanings</span></div></div>` : "";
    if (sm?.last) {
      hist += `<dl class="kv"><dt>Last clean</dt><dd>${fmtWhen(sm.last.begin)}</dd><dt>Duration</dt><dd>${fmtDuration(sm.last.duration)}</dd><dt>Area</dt><dd>${fmtArea(sm.last.area)}</dd><dt>Finished</dt><dd>${sm.last.complete ? "Yes" : "No"}</dd></dl>`;
    }
    if (!sm) hist = `<p class="muted">Robot history summary isn't available right now. Locally saved runs are shown below.</p>`;
    cards.push(`<div class="card history-card" id="history-runs"><div class="card-head"><h3 class="card-title">${icon("history")}History</h3></div>${hist}
      <div id="history-runs-list"><p class="muted">Loading run history…</p></div><div id="history-run-detail"></div></div>`);
  }

  if (notifySupported()) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("bell")}Notifications</h3></div>
      ${row("alert", "When it needs help", "A desktop notification when it gets stuck or the dock needs attention, while this page is open", sw("notify", notifyEnabled()))}</div>`);
  }
  cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("sun")}Appearance</h3></div>
    <div class="row stack"><div class="row-main"><span class="row-icon">${icon("contrast")}</span><div><div class="row-title">Theme</div><div class="row-sub">Auto follows your Mac's light or dark setting</div></div></div>${themeChoice()}</div>
    ${row("spark", "SmartPlan", "Offer SmartPlan in Cleaning mode", sw("smartplan", smartPlanShown()))}</div>`);

  const refreshSeconds = (() => {
    try {
      const value = Number(localStorage.getItem("map-refresh-seconds"));
      return [10, 20, 30, 60].includes(value) ? value : 20;
    } catch { return 20; }
  })();
  cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("layers")}App</h3></div>
    <div class="row stack"><div class="row-main"><span class="row-icon">${icon("history")}</span><div><div class="row-title">Robot and map refresh</div><div class="row-sub">While idle. During cleaning, updates are more frequent.</div></div></div>
      <select id="map-refresh-setting" class="field app-setting-select">
        <option value="10" ${refreshSeconds === 10 ? "selected" : ""}>Every 10 seconds</option>
        <option value="20" ${refreshSeconds === 20 ? "selected" : ""}>Every 20 seconds</option>
        <option value="30" ${refreshSeconds === 30 ? "selected" : ""}>Every 30 seconds</option>
        <option value="60" ${refreshSeconds === 60 ? "selected" : ""}>Every minute</option>
      </select>
    </div>
    <div class="row"><div class="row-main"><span class="row-icon">${icon("trash")}</span><div><div class="row-title">Saved map versions</div><div class="row-sub">Stored in this browser for each robot.</div></div></div><button class="btn-soft danger" data-act="clear-map-history">Clear</button></div>
  </div>`);

  // About
  const d = s.device ?? {};
  const n = s.network ?? {};
  cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("info")}About</h3></div>
    <dl class="kv">
      <dt>Model</dt><dd>${esc(d.product || d.model || "–")}</dd>
      ${d.firmware ? `<dt>Firmware</dt><dd>${esc(d.firmware)}</dd>` : ""}
      ${n.ip ? `<dt>IP address</dt><dd>${esc(n.ip)}</dd>` : ""}
      ${n.ssid ? `<dt>Wi‑Fi</dt><dd>${esc(n.ssid)}${n.rssi ? ` · ${n.rssi} dBm` : ""}</dd>` : ""}
      <dt>Connection</dt><dd>${connectionText()}${blockedNote(S.status?.links)}</dd>
      <dt>Account</dt><dd>${esc(S.auth?.email || "–")}</dd>
    </dl>
    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn-soft" data-act="refresh-settings">Refresh</button>
      ${S.auth?.demo ? "" : `<button class="btn-soft danger" data-act="logout">${icon("logout")}Sign out</button>`}
    </div></div>`);

  $("#settings").innerHTML = cards.join("");
  renderRunHistory();

  const vol = $opt<HTMLInputElement>("#vol");
  if (vol) {
    vol.oninput = () => {
      $("#vol-out").textContent = vol.value;
    };
    vol.onchange = () => {
      doAction("set_volume", { value: Number(vol.value) }, { okMsg: "Volume saved" }).catch(() => {});
    };
  }
  const start = $opt<HTMLInputElement>("#dnd-start");
  const end = $opt<HTMLInputElement>("#dnd-end");
  if (start && end) {
    start.onchange = sendDnd;
    end.onchange = sendDnd;
  }
}

function sendDnd(): void {
  const s = S.settings;
  const toggle = $opt<HTMLInputElement>("[data-switch=dnd]");
  const start = $opt<HTMLInputElement>("#dnd-start");
  const end = $opt<HTMLInputElement>("#dnd-end");
  if (!s || !toggle || !start || !end) return;
  const on = toggle.checked;
  s.dnd = { enabled: on, start: start.value, end: end.value };
  doAction("set_dnd", { ...s.dnd }, { okMsg: on ? "Do not disturb saved" : "Do not disturb off" }).catch(() => {});
}

/** Pick an option like the auto-empty mode, showing it straight away. */
export async function setChoice(action: string, value: string): Promise<void> {
  const s = S.settings;
  const key = action === "set_dust_mode" ? "dust_mode" : "wash_mode";
  const opt = s?.[key];
  if (!opt) return;
  const prev = opt.value;
  opt.value = value;
  renderSettings();
  try {
    await doAction(action, { value }, { okMsg: "Saved" });
  } catch {
    opt.value = prev;
    renderSettings();
  }
}

const SETTING_KEY: Record<string, "child_lock" | "led" | "flow_led" | "carpet_boost"> = {
  set_child_lock: "child_lock",
  set_led: "led",
  set_flow_led: "flow_led",
  set_carpet_boost: "carpet_boost",
};

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.matches("[data-switch]")) return;
  const action = t.dataset.switch ?? "";
  if (action === "dnd") {
    sendDnd();
    return;
  }
  if (action === "notify") {
    t.checked = await setNotify(t.checked);
    return;
  }
  if (action === "smartplan") {
    setSmartPlanShown(t.checked);
    toast(t.checked ? "SmartPlan is back in Cleaning mode" : "SmartPlan is hidden");
    return;
  }
  const on = t.checked;
  try {
    if (action === "set_smart_wash") await doAction(action, { enabled: on }, { okMsg: "Saved" });
    else await doAction(action, { on }, { okMsg: "Saved" });
    const s = S.settings;
    if (!s) return;
    const key = SETTING_KEY[action];
    if (key) s[key] = on;
    if (action === "set_mop_dryer" && s.mop_dryer) s.mop_dryer.enabled = on;
    if (action === "set_smart_wash" && s.smart_wash) s.smart_wash.enabled = on;
  } catch {
    t.checked = !on;
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.id !== "map-refresh-setting") return;
  try { localStorage.setItem("map-refresh-seconds", target.value); } catch { /* setting applies until reload */ }
  toast(`Map refresh set to every ${target.value} seconds while idle`);
});
