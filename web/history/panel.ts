// Cleaning history, detailed timelines and route replay in the Settings tab.

import { parseTranscript, validTimelineLine } from "./app-timeline";
import type { AppTimeline } from "./app-timeline";
import { routeMetrics, runDetailHtml } from "./detail-view";
import { historyListHtml } from "./list-view";
import { advanceReplay, deleteHistoryRun, loadHistoryRun, selectRuns } from "./model";
import type { HistoryResultFilter, HistorySort, HistoryTypeFilter } from "./model";
import { api, devicePath } from "../api";
import { $, $opt, closest, errorMessage, fmtDuration, fmtWhen, toast } from "../dom";
import { S } from "../state";
import type { RunDetail, RunSummary } from "../types";

export { historyCard } from "./list-view";

let runHistory: RunSummary[] = [];
let historyRequest = 0;
let fetchingHistoryMap = false;
let selectedRunId: string | null = null;
let selectedRun: RunDetail | null = null;
let historyLoadError: string | null = null;
let runHistoryLoading = true;
let historyResultFilter: HistoryResultFilter = "all";
let historyTypeFilter: HistoryTypeFilter = "all";
let historySort: HistorySort = "newest";
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

export function renderRunHistory(): void {
  const list = $opt<HTMLElement>("#history-runs-list");
  const detail = $opt<HTMLElement>("#history-run-detail");
  if (!list || !detail) return;
  const keepDetailFocus = detail.contains(document.activeElement);
  const backupLink = $opt<HTMLAnchorElement>("[data-history-export]");
  if (backupLink) backupLink.href = devicePath("history-backup");
  list.hidden = selectedRunId !== null;
  detail.hidden = selectedRunId === null;
  list.setAttribute("aria-busy", String(runHistoryLoading && selectedRunId === null));
  detail.setAttribute("aria-busy", String(runHistoryLoading && selectedRunId !== null));
  const filters = { result: historyResultFilter, type: historyTypeFilter, sort: historySort };
  const filteredRuns = selectRuns(runHistory, filters);
  list.innerHTML = selectedRunId ? "" : historyListHtml(runHistory, filteredRuns, runHistoryLoading, filters);
  const app = selectedRun ? readAppTimeline(selectedRun.id) : { text: "" };
  detail.innerHTML = runDetailHtml({
    selectedRunId,
    selectedRun,
    fetchingHistoryMap,
    loadError: historyLoadError,
    routeSpeed,
    routeProgress,
    appTimeline: app.text,
    transcript: app.transcript,
  });
  syncRouteProgress();
  syncSpeedButtons();
  syncRouteToggles();
  applyMapView();
  if (keepDetailFocus) detail.querySelector<HTMLElement>(".run-detail")?.focus();
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
  historyLoadError = null;
  runHistoryLoading = true;
  routeProgress = 0;
  routeSpeed = 1;
  showVacuumRoute = true;
  showMopRoute = true;
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
  renderRunHistory();
  requestAnimationFrame(() => settingsRoot.querySelector<HTMLElement>(".run-detail")?.focus());
  const request = ++historyRequest;
  const current = () => request === historyRequest && selectedRunId === id;
  const path = devicePath(`runs/${encodeURIComponent(id)}`);
  fetchingHistoryMap = false;
  try {
    const loaded = await loadHistoryRun(path, (target) => api<RunDetail>(target), (cached, needsMap) => {
      if (!current()) return;
      selectedRun = cached;
      fetchingHistoryMap = needsMap;
      renderRunHistory();
    });
    if (!current()) return;
    selectedRun = loaded;
  } catch (e) {
    if (current()) {
      historyLoadError = `Couldn't load run details: ${errorMessage(e)}`;
      toast(historyLoadError, true);
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

function closeHistoryRun(): void {
  const id = selectedRunId;
  if (routeTimer != null) window.clearInterval(routeTimer);
  routeTimer = null;
  selectedRunId = null;
  selectedRun = null;
  historyLoadError = null;
  renderRunHistory();
  if (id) requestAnimationFrame(() => settingsRoot.querySelector<HTMLElement>(`[data-run="${CSS.escape(id)}"]`)?.focus());
}

settingsRoot.addEventListener("change", async (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.matches("[data-history-import]")) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 50_000_000) throw new Error("This history backup is too large.");
      const backup: unknown = JSON.parse(await file.text());
      if (!backup || typeof backup !== "object") throw new Error("This backup is not valid JSON.");
      if (!confirm("Restore this backup? It will replace locally stored history for this robot.")) return;
      await api(devicePath("history-backup"), { method: "POST", body: backup });
      const browserTimelines = (backup as { browser_timelines?: unknown }).browser_timelines;
      if (browserTimelines && typeof browserTimelines === "object") {
        const prefix = `roborock:app-timeline:${S.duid}:`;
        for (const [runId, timeline] of Object.entries(browserTimelines)) {
          if (typeof timeline === "string") localStorage.setItem(prefix + runId, timeline);
        }
      }
      selectedRunId = null;
      selectedRun = null;
      historyLoadError = null;
      await loadRunHistory();
      document.dispatchEvent(new CustomEvent("settings-refresh-request"));
      toast("History backup restored");
    } catch (error) {
      toast(`Couldn't restore history: ${errorMessage(error)}`, true);
    } finally {
      input.value = "";
    }
    return;
  }
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
  const exportLink = closest<HTMLAnchorElement>(e.target, "[data-history-export]");
  if (exportLink) {
    e.preventDefault();
    try {
      const backup = await api<Record<string, unknown>>(devicePath("history-backup"));
      const prefix = `roborock:app-timeline:${S.duid}:`;
      const browserTimelines: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) browserTimelines[key.slice(prefix.length)] = localStorage.getItem(key) ?? "";
      }
      backup.browser_timelines = browserTimelines;
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
      const download = document.createElement("a");
      download.href = url;
      download.download = `roborock-history-${S.duid}.json`;
      download.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(`Couldn't download history: ${errorMessage(error)}`, true);
    }
    return;
  }
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
    closeHistoryRun();
    return;
  }
  const retry = closest<HTMLButtonElement>(e.target, "[data-run-retry]");
  if (retry) {
    await openHistoryRun(retry.dataset.runRetry ?? "");
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
      runHistory = await deleteHistoryRun(runHistory, id, () => api<void>(devicePath(`runs/${encodeURIComponent(id)}`), { method: "DELETE" }));
      if (routeTimer != null) window.clearInterval(routeTimer);
      routeTimer = null;
      if (selectedRunId === id) {
        selectedRunId = null;
        selectedRun = null;
      }
      renderRunHistory();
      toast("Cleaning run deleted");
      document.dispatchEvent(new CustomEvent("settings-refresh-request"));
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
    routeProgress = advanceReplay(routeProgress, routeSpeed);
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selectedRunId && S.tab === "settings") closeHistoryRun();
});

