import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  advanceReplay,
  deleteHistoryRun,
  loadHistoryRun,
  idleRefreshMs,
  loopRefreshMs,
  mapRefreshMs,
  runDetailHtml,
  runTimeline,
  selectRuns,
} from "/tmp/roborock-web-history-tests.mjs";

const summary = (id, values = {}) => ({
  id, begin: 1, end: 2, duration: 60, area: 2, complete: true,
  source: "robot", mapped: false, mopped: false, rooms: [], ...values,
});

const detail = (values = {}) => ({
  id: "run-1", begin: 100, end: 200, duration: 100, area: 2, complete: true,
  mode: null, source: "robot", start_type: null, finish_reason: null,
  avoid_count: null, wash_count: null, record_details: {}, events: [],
  route: { map: "1", path: [], mop_path: [] },
  map: { base: "data:image/png", width: 10, height: 10 }, ...values,
});

test("opening a complete cached run avoids a second request", async () => {
  const calls = [];
  const run = detail();
  const loaded = await loadHistoryRun("/runs/run-1", async (path) => { calls.push(path); return run; });
  assert.equal(loaded, run);
  assert.deepEqual(calls, ["/runs/run-1?cached=true"]);
});

test("opening an incomplete cached run refreshes its map and timeline", async () => {
  const calls = [];
  const cached = detail({ route: null, map: null, needs_timeline: true });
  const fresh = detail();
  let cachedState;
  const loaded = await loadHistoryRun("/runs/run-1", async (path) => {
    calls.push(path);
    return path.includes("cached") ? cached : fresh;
  }, (run, needsMap) => { cachedState = [run, needsMap]; });
  assert.equal(loaded, fresh);
  assert.deepEqual(calls, ["/runs/run-1?cached=true", "/runs/run-1"]);
  assert.deepEqual(cachedState, [cached, true]);
});

test("replay advances at 1x, 3x and 5x and stops at the end", () => {
  assert.equal(advanceReplay(0, 1, 60_000), 1000);
  assert.equal(advanceReplay(0, 3, 10_000), 500);
  assert.equal(advanceReplay(0, 5, 6_000), 500);
  assert.equal(advanceReplay(990, 5, 1_000), 1000);
});

test("deleting waits for the server before removing a run", async () => {
  const runs = [summary("a"), summary("b")];
  let removed = false;
  const result = await deleteHistoryRun(runs, "a", async () => { removed = true; });
  assert.equal(removed, true);
  assert.deepEqual(result.map(run => run.id), ["b"]);
  await assert.rejects(() => deleteHistoryRun(runs, "a", async () => { throw new Error("no"); }));
  assert.deepEqual(runs.map(run => run.id), ["a", "b"]);
});

test("history filters and sorts the same runs shown by the UI", () => {
  const runs = [summary("vac", { begin: 2 }), summary("mop", { begin: 3, mopped: true }), summary("remop", { begin: 1, mopped: true, remopped: true })];
  const result = selectRuns(runs, { result: "all", type: "mopped", sort: "newest" });
  assert.deepEqual(result.map(run => run.id), ["mop", "remop"]);
});

test("timeline uses detailed robot events and suppresses duplicate pass rows", () => {
  const run = detail({ events: [
    { at: 110, label: "Vacuum pass in selected rooms" },
    { at: 115, label: "Cleaning Kitchen", detail: "Vacuum · Vac followed by Mop" },
    { at: 150, label: "Washing mop", detail: "Deep · Hot Water" },
  ] });
  const labels = runTimeline(run, "Completed").map(step => step.label);
  assert.deepEqual(labels, ["Start selective room cleaning", "Clean Kitchen", "Wash Mop", "Cleaning Finished"]);
});

test("timeline trusts the device timeline when Roborock provides it", () => {
  const deviceTimeline = [{ at: 100, label: "Start selective room cleaning" }, { at: 200, label: "Cleaning Finished" }];
  assert.equal(runTimeline(detail({ device_timeline: deviceTimeline }), "Completed"), deviceTimeline);
});

test("anonymized Saros fixtures keep detailed and observed timelines stable", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/saros-history.json", import.meta.url), "utf8"));
  assert.equal(fixture.model, "Saros 20 Sonic");
  const detailed = runTimeline(fixture.runs[0], "Completed");
  assert.deepEqual(detailed.map(step => step.label), [
    "Start selective room cleaning", "Wash Mop", "Clean Kitchen",
    "Auto Emptying", "Automatic Re-Mopping", "Cleaning Finished",
  ]);
  const observed = runTimeline(fixture.runs[1], "Completed");
  assert.deepEqual(observed.map(step => step.label), [
    "Start selective room cleaning", "Clean Bathroom", "Wash Mop",
    "Resume", "Clean Bathroom", "Cleaning Finished",
  ]);
});

test("history detail keeps its visual component contract", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/saros-history.json", import.meta.url), "utf8"));
  const run = { ...fixture.runs[0], source: "demo" };
  const html = runDetailHtml({
    selectedRunId: run.id,
    selectedRun: run,
    fetchingHistoryMap: false,
    loadError: null,
    routeSpeed: 3,
    routeProgress: 250,
    appTimeline: "",
  });
  const contract = {
    accessibleRegion: html.includes('role="region" aria-label="Cleaning run details"'),
    mapBeforeTimeline: html.indexOf('class="run-map"') < html.indexOf('class="rr-timeline"'),
    replaySpeeds: [...html.matchAll(/data-run-speed="(\d)"/g)].map(match => match[1]),
    activeSpeed: html.includes('replay-speed is-active" data-run-speed="3"'),
    routeLayers: [...html.matchAll(/data-route-group="(clean|mop)"/g)].map(match => match[1]),
    aiBadgeSingleLineMarkup: html.includes('<div class="rr-detail rr-ai"><b>AI</b><div>'),
    timelineOrder: ["Start selective room cleaning", "Wash Mop", "Clean Kitchen", "Auto Emptying", "Automatic Re-Mopping", "Cleaning Finished"]
      .map(label => html.indexOf(label)),
    summaryFooter: html.includes("Cleaning Time</small>") && html.includes("Cleaning Area</small>"),
  };
  assert.deepEqual(contract, {
    accessibleRegion: true,
    mapBeforeTimeline: true,
    replaySpeeds: ["1", "3", "5"],
    activeSpeed: true,
    routeLayers: ["clean", "mop"],
    aiBadgeSingleLineMarkup: true,
    timelineOrder: [...contract.timelineOrder].sort((a, b) => a - b),
    summaryFooter: true,
  });
});

test("live map uses the fast refresh policy only while the robot is active", () => {
  assert.equal(idleRefreshMs(20), 20_000);
  assert.equal(idleRefreshMs(7), 20_000);
  assert.equal(mapRefreshMs("idle", 60_000), 60_000);
  assert.equal(mapRefreshMs("cleaning", 60_000), 3000);
  assert.equal(mapRefreshMs("returning", 60_000), 3000);
  assert.equal(loopRefreshMs("idle"), 5000);
  assert.equal(loopRefreshMs("cleaning"), 3000);
});
