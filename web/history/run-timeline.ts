import type { RunDetail } from "../types";

type RunEvent = NonNullable<RunDetail["events"]>[number];

export interface TimelineStep {
  at: number | null;
  label: string;
  detail?: string;
  approximate?: boolean;
  clean?: NonNullable<RunDetail["device_timeline"]>[number]["clean"];
}

const dockLabels: Record<string, string> = {
  "Washing mop": "Wash Mop",
  "Emptying dustbin": "Auto Emptying",
  "Resuming cleaning": "Resume",
  "Detaching mop mounts": "Detaching mop cloth mounts",
  "Installing mop mounts": "Installing mop cloth mounts",
};

function roomEvent(event?: RunEvent): boolean {
  return !!event && event.label.startsWith("Cleaning ") && event.detail !== undefined;
}

export function runTimeline(run: RunDetail, result: string): TimelineStep[] {
  if (run.device_timeline?.length) return run.device_timeline;
  const events = [...(run.events ?? [])].sort((a, b) => a.at - b.at);
  const extra = run.record_details;
  const sequence = events.some(event => roomEvent(event) && event.detail?.split(" · ").includes("Vac followed by Mop"));
  const selectedRooms = extra?.rooms || events.some(e => e.label.includes("selected rooms"));
  const steps: TimelineStep[] = [{
    at: run.begin,
    label: selectedRooms ? "Start selective room cleaning" : "Start cleaning",
    detail: sequence ? "Vac followed by Mop" : undefined,
  }];
  const markers = events.filter(e => e.label === "Replenishment mode observed while mopping");
  const roomEvents = events.filter(roomEvent);
  const remopped = (extra?.dirty_replenish ?? 0) > 0;
  const timedRemop = remopped && extra?.manual_replenish === 0 && markers.length === 1 ? markers[0] : undefined;
  for (const event of events) {
    if (event.label === "Replenishment mode observed while mopping") {
      if (event === timedRemop) steps.push({
        at: event.at, label: "Automatic Re-Mopping", approximate: true,
        detail: `The robot reported ${extra?.dirty_replenish?.toFixed(1)} m² of automatic re-mopping. Time estimated from the live mop pass.`,
      });
      continue;
    }
    if (event.label === "Starting cleaning" && event.at === run.begin) continue;
    // Live status exposes both a broad pass transition and a room transition.
    // The Roborock app shows the room row, so suppress the duplicate broad row
    // when a room row follows it in the same part of the run.
    if (/^(Vacuum|Mop) pass(?: in selected (?:rooms|zone))?$/.test(event.label)
        && roomEvents.some(room => Math.abs(room.at - event.at) <= 30)) continue;
    const room = roomEvent(event);
    const detail = room ? event.detail?.split(" · ").filter(d => d !== "Vac followed by Mop").join(" · ") : event.detail;
    steps.push({at: event.at, label: room ? "Clean " + event.label.slice(9) : dockLabels[event.label] ?? event.label, detail});
  }
  steps.push({at: run.end, label: run.complete === true ? "Cleaning Finished" : result,
    detail: run.complete === true ? undefined : run.finish_reason?.replaceAll("_", " ")});
  // Totals survive even if the server was offline for some or all of a run.
  // Reconcile them with observed transitions to avoid adding a wash twice.
  const washed = events.filter(event => event.label === "Washing mop").length;
  const missingWashes = (run.wash_count ?? 0) - washed;
  if (missingWashes > 0) steps.push({
    at: null, label: "Wash Mop",
    detail: missingWashes === 1 ? "1 wash" : `${missingWashes} washes`,
  });
  if (run.dust_collected && !events.some(event => event.label === "Emptying dustbin")) {
    steps.push({at: null, label: "Auto Emptying"});
  }
  if (remopped && !timedRemop) steps.push({
    at: null, label: "Automatic Re-Mopping",
    detail: `Re-mopped area: ${(extra?.dirty_replenish ?? 0).toFixed(1)} m²`,
  });
  return steps;
}

