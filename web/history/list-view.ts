import { esc, fmtArea, fmtDuration, fmtWhen, icon } from "../dom";
import type { RunSummary, Settings } from "../types";
import type { HistoryFilters } from "./model";

export function historyCard(summary: Settings["summary"]): string {
  let content = summary ? `<div class="big-stats">
    <div class="stat"><b>${summary.total_time != null ? Math.round(summary.total_time / 3600) + " h" : "–"}</b><span>Total time</span></div>
    <div class="stat"><b>${fmtArea(summary.total_area)}</b><span>Total area</span></div>
    <div class="stat"><b>${summary.count ?? "–"}</b><span>Cleanings</span></div></div>` : "";
  if (summary?.last) {
    content += `<dl class="kv"><dt>Last clean</dt><dd>${fmtWhen(summary.last.begin)}</dd><dt>Duration</dt><dd>${fmtDuration(summary.last.duration)}</dd><dt>Area</dt><dd>${fmtArea(summary.last.area)}</dd><dt>Finished</dt><dd>${summary.last.complete ? "Yes" : "No"}</dd></dl>`;
  }
  if (!summary) content = `<p class="muted">Robot history summary isn't available right now. Locally saved runs are shown below.</p>`;
  return `<div class="card history-card" id="history-runs"><div class="card-head"><h3 class="card-title">${icon("history")}History</h3></div>${content}
    <div id="history-runs-list"><p class="muted">Loading run history…</p></div><div id="history-run-detail"></div>
    <details class="history-backup"><summary>History backup</summary><p class="muted">Save or restore locally stored runs, maps and timeline events.</p>
      <a class="btn-soft" href="#" data-history-export>Download backup</a>
      <label class="btn-soft">Restore backup<input class="visually-hidden" type="file" accept=".json,application/json" data-history-import></label>
    </details></div>`;
}

export function historyListHtml(runs: RunSummary[], filteredRuns: RunSummary[], loading: boolean, filters: HistoryFilters): string {
  if (!runs.length) return `<p class="muted">${loading ? "Loading run history…" : "No recent runs available."}</p>`;
  const selected = (value: string, expected: string) => value === expected ? " selected" : "";
  const items = filteredRuns.map((run) => {
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
  }).join("");
  return `<div class="history-runs-head"><div class="history-runs-label">Recent runs <small>${filteredRuns.length} of ${runs.length}</small></div>
    <div class="history-run-filters">
      <label>Result<select data-history-result><option value="all"${selected(filters.result, "all")}>All</option><option value="completed"${selected(filters.result, "completed")}>Completed</option><option value="incomplete"${selected(filters.result, "incomplete")}>Stopped</option></select></label>
      <label>Cleaning<select data-history-type><option value="all"${selected(filters.type, "all")}>All</option><option value="vacuum"${selected(filters.type, "vacuum")}>Vacuum only</option><option value="mopped"${selected(filters.type, "mopped")}>Mopped</option><option value="remopped"${selected(filters.type, "remopped")}>Re-mopped</option></select></label>
      <label>Sort<select data-history-sort><option value="newest"${selected(filters.sort, "newest")}>Newest</option><option value="oldest"${selected(filters.sort, "oldest")}>Oldest</option><option value="longest"${selected(filters.sort, "longest")}>Longest</option><option value="largest"${selected(filters.sort, "largest")}>Largest area</option></select></label>
    </div></div>${items ? `<ul class="history-runs-list">${items}</ul>` : `<p class="muted history-filter-empty">No runs match these filters.</p>`}`;
}
