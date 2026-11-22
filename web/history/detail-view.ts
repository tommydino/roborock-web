// Rendering for one history run: map, replay controls and Roborock-style timeline.

import { devicePath } from "../api";
import { esc, fmtArea, fmtDuration, fmtWhen, human, icon } from "../dom";
import type { DeviceTimelineStep, RunDetail } from "../types";
import type { AppTimeline } from "./app-timeline";
import { runTimeline } from "./run-timeline";

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

export function routeMetrics(lines: number[][][]): { length: number; segments: Array<{ a: number[]; b: number[]; from: number; length: number }> } {
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

export interface DetailViewState {
  selectedRunId: string | null;
  selectedRun: RunDetail | null;
  fetchingHistoryMap: boolean;
  routeSpeed: number;
  routeProgress: number;
  appTimeline: string;
  transcript?: AppTimeline;
}

export function runDetailHtml(state: DetailViewState): string {
  const { selectedRunId, selectedRun, fetchingHistoryMap, routeSpeed, routeProgress, appTimeline, transcript } = state;
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


