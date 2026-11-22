import type { Phase } from "./types";

export function idleRefreshMs(value: number): number {
  return [10, 20, 30, 60].includes(value) ? value * 1000 : 20_000;
}

export function mapRefreshMs(phase: Phase | undefined, idleMs: number): number {
  return phase === "cleaning" || phase === "returning" ? 3000 : idleMs;
}

/** How soon the browser checks again. Map polling still applies its own idle limit. */
export function loopRefreshMs(phase: Phase | undefined): number {
  return phase === "cleaning" || phase === "returning" ? 3000 : 5000;
}
