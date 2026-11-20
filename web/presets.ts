import type { MapPayload } from "./types";
import { S } from "./state";

export interface SavedZone {
  id: string;
  name: string;
  rect: [number, number, number, number]; // fractions of the current map
}

export interface CleaningPlan {
  id: string;
  name: string;
  rooms: number[];
  repeat: number;
  cleaning?: string | null;
  fan?: number | null;
  water?: number | null;
  mop?: number | null;
}

interface Presets { zones: SavedZone[]; plans: CleaningPlan[] }

const key = () => `roborock:presets:${S.duid ?? "none"}`;

export function presets(): Presets {
  try {
    const value = JSON.parse(localStorage.getItem(key()) ?? "{}");
    return {
      zones: Array.isArray(value.zones) ? value.zones : [],
      plans: Array.isArray(value.plans) ? value.plans : [],
    };
  } catch { return { zones: [], plans: [] }; }
}

function write(value: Presets): void {
  localStorage.setItem(key(), JSON.stringify(value));
}

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function saveZone(name: string, rect: [number, number, number, number], map: MapPayload): void {
  const [x0, y0, x1, y1] = rect;
  const value = presets();
  value.zones.push({ id: id(), name, rect: [x0 / map.width, y0 / map.height, x1 / map.width, y1 / map.height] });
  write(value);
}

export function restoreZone(zoneId: string, map: MapPayload): [number, number, number, number] | null {
  const zone = presets().zones.find((item) => item.id === zoneId);
  if (!zone) return null;
  return [zone.rect[0] * map.width, zone.rect[1] * map.height, zone.rect[2] * map.width, zone.rect[3] * map.height];
}

export function savePlan(name: string, rooms: number[], repeat: number): void {
  const mode = S.status?.mode;
  const value = presets();
  value.plans.push({ id: id(), name, rooms: [...rooms], repeat, cleaning: mode?.cleaning,
    fan: mode?.fan, water: mode?.water, mop: mode?.mop });
  write(value);
}

export function deletePreset(kind: "zone" | "plan", presetId: string): void {
  const value = presets();
  if (kind === "zone") value.zones = value.zones.filter((item) => item.id !== presetId);
  else value.plans = value.plans.filter((item) => item.id !== presetId);
  write(value);
}
