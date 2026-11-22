// A user-supplied transcript belongs to one run. Keep the original order even
// when two actions share the same minute in the Roborock app.
export interface AppTimeline {
  run_id: string;
  summary: string;
  area_m2: number;
  events: string[];
}

export const validTimelineLine = (line: string): boolean =>
  /^([01]\d|2[0-3]):[0-5]\d[ \t]+\S/.test(line) && !/[\r\n]/.test(line);

export function parseTranscript(text: string, runId: string): AppTimeline {
  const data = JSON.parse(text);
  if (data?.run_id !== runId) throw new Error("This file belongs to a different cleaning run.");
  if (typeof data.summary !== "string" || data.summary.length > 400 ||
      !Number.isFinite(data.area_m2) || data.area_m2 < 0 ||
      !Array.isArray(data.events) || !data.events.length || data.events.length > 500 ||
      !data.events.every((line: unknown) => typeof line === "string" && validTimelineLine(line)) ||
      data.events.join("\n").length > 20000) {
    throw new Error("The file does not contain a valid app timeline.");
  }
  return {run_id: runId, summary: data.summary, area_m2: data.area_m2, events: data.events};
}

