import type { RunDetail, RunSummary } from "../types";

export type HistoryResultFilter = "all" | "completed" | "incomplete";
export type HistoryTypeFilter = "all" | "vacuum" | "mopped" | "remopped";
export type HistorySort = "newest" | "oldest" | "longest" | "largest";

export interface HistoryFilters {
  result: HistoryResultFilter;
  type: HistoryTypeFilter;
  sort: HistorySort;
}

export function selectRuns(runs: RunSummary[], filters: HistoryFilters): RunSummary[] {
  return runs.filter((run) => {
    if (filters.result === "completed" && run.complete !== true) return false;
    if (filters.result === "incomplete" && run.complete !== false) return false;
    if (filters.type === "vacuum" && run.mopped) return false;
    if (filters.type === "mopped" && !run.mopped) return false;
    if (filters.type === "remopped" && !run.remopped) return false;
    return true;
  }).sort((a, b) => {
    if (filters.sort === "oldest") return a.begin - b.begin;
    if (filters.sort === "longest") return (b.duration ?? 0) - (a.duration ?? 0);
    if (filters.sort === "largest") return (b.area ?? 0) - (a.area ?? 0);
    return b.begin - a.begin;
  });
}

export function needsRunRefresh(run: RunDetail): boolean {
  return run.source !== "demo" && (!run.route || !run.map || run.record_details == null || run.needs_timeline === true);
}

export async function loadHistoryRun(
  path: string,
  fetchRun: (path: string) => Promise<RunDetail>,
  onCached?: (run: RunDetail, needsMap: boolean) => void,
): Promise<RunDetail> {
  const cached = await fetchRun(path + "?cached=true");
  if (!needsRunRefresh(cached)) return cached;
  onCached?.(cached, !cached.route || !cached.map);
  return fetchRun(path);
}

export async function deleteHistoryRun(
  runs: RunSummary[],
  id: string,
  remove: () => Promise<void>,
): Promise<RunSummary[]> {
  await remove();
  return runs.filter((run) => run.id !== id);
}

export function advanceReplay(progress: number, speed: number, elapsedMs = 50): number {
  const safeSpeed = [1, 3, 5].includes(speed) ? speed : 1;
  return Math.min(1000, progress + (elapsedMs * safeSpeed * 1000) / 60_000);
}
