import type { RunDetail } from "./types";

type RunEvent = NonNullable<RunDetail["events"]>[number];

export interface TimelineStep {
  at: number | null;
  label: string;
  detail?: string;
  approximate?: boolean;
}

const dockLabels: Record<string, string> = {
  "Washing mop": "Wash Mop",
  "Emptying dustbin": "Auto Emptying",
  "Resuming cleaning": "Resume",
  "Detaching mop mounts": "Detaching mop cloth mounts",
  "Installing mop mounts": "Installing mop cloth mounts",
};

const passLabels = new Set([
  "Vacuum pass", "Vacuum pass in selected rooms", "Vacuum pass in selected zone",
  "Mop pass", "Mop pass in selected rooms", "Mop pass in selected zone",
  "Mopping", "Mopping selected rooms", "Mopping selected zone", "Cleaning selected rooms",
]);

function roomEvent(event?: RunEvent): boolean {
  return !!event && event.label.startsWith("Cleaning ") && event.detail !== undefined;
}

export function runTimeline(run: RunDetail, result: string): TimelineStep[] {
  const events = [...(run.events ?? [])].sort((a, b) => a.at - b.at);
  const extra = run.record_details;
  const sequence = events.some(event => roomEvent(event) && event.detail?.split(" · ").includes("Vac followed by Mop"));
  const selectedRooms = extra?.rooms || events.some(e => e.label.includes("selected rooms"));
  const hasRoomRows = events.some(event => roomEvent(event));
  const steps: TimelineStep[] = [{
    at: run.begin,
    label: selectedRooms ? "Start selective room cleaning" : "Start cleaning",
    detail: sequence ? "Vac followed by Mop" : undefined,
  }];
  const markers = events.filter(e => e.label === "Replenishment mode observed while mopping");
  const remopped = (extra?.dirty_replenish ?? 0) > 0;
  const timedRemop = remopped && extra?.manual_replenish === 0 && markers.length === 1 ? markers[0] : undefined;
  const combined = new Set<RunEvent>();
  if (timedRemop) {
    // The observer emits the resume, pass, and room around the same change.
    // Combine only adjacent reports from that transition, not earlier visits.
    const marker = events.indexOf(timedRemop);
    for (let i = marker - 1; i >= 0 && timedRemop.at - events[i].at <= 5; i--) {
      if (events[i].label !== "Resuming cleaning" && !passLabels.has(events[i].label)) break;
      combined.add(events[i]);
    }
    const room = events[marker + 1];
    if (roomEvent(room) && room.at - timedRemop.at <= 1) combined.add(room);
  }
  for (const [index, event] of events.entries()) {
    if (combined.has(event)) continue;
    if (event.label === "Replenishment mode observed while mopping") {
      if (event === timedRemop) steps.push({
        at: event.at, label: "Automatic Re-Mopping", approximate: true,
        detail: `The robot reported ${extra?.dirty_replenish?.toFixed(1)} m² of automatic re-mopping. Time estimated from the live mop pass.`,
      });
      continue;
    }
    // Dock navigation is already visible on the map. Keep the actual dock
    // actions in the timeline when we have a room-by-room account.
    if (hasRoomRows && ["Returning to dock to wash mop", "Returning to dock", "Docking"].includes(event.label)) continue;
    if (event.label === "Starting cleaning" || (passLabels.has(event.label) && roomEvent(events[index + 1]))) continue;
    const room = roomEvent(event);
    const detail = room ? event.detail?.split(" · ").filter(d => d !== "Vac followed by Mop").join(" · ") : event.detail;
    steps.push({at: event.at, label: room ? "Clean " + event.label.slice(9) : dockLabels[event.label] ?? event.label, detail});
  }
  steps.push({at: run.end, label: run.complete === true ? "Cleaning Finished" : result,
    detail: run.complete === true ? undefined : run.finish_reason?.replaceAll("_", " ")});
  // Keep an untimed finding out of the timestamped sequence.
  if (remopped && !timedRemop) steps.push({
    at: null, label: "Automatic Re-Mopping",
    detail: `Re-mopped area: ${(extra?.dirty_replenish ?? 0).toFixed(1)} m² · Time unavailable`,
  });
  return steps;
}
