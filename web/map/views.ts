// Map views: the colour map (2D), the floor plan, and the 3D view.

import type { Map3D, Marker3D } from "../map3d";
import { $, $$, toast } from "../dom";
import { S, type ViewMode } from "../state";
import { drawSelection, refreshMapOverlays, roomAt, setTool, toggleRoom } from "./core";
import { itemPx } from "./editor";
import { freshImage, loadFreshness, renderFreshPanel } from "../freshness";
import { loadSuspects, renderSusPanel, suspectsImage } from "../suspects";
import { inner, mapImg, selCanvas, stage } from "./elements";
import { buttonsReach, homeBox, stagePadding } from "./fit";
import { groupObstacles, OBSTACLE_ICON } from "./layers";
import { applyView } from "./panzoom";
import { colourImage, planImage } from "./paint";

export { planImage };

export function setViewMode(mode: ViewMode): void {
  if (mode === S.viewMode) return;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    doc.startViewTransition(() => switchView(mode));
  } else switchView(mode);
}

function switchView(mode: ViewMode): void {
  if (mode === "3d" && S.tool !== "rooms") setTool("rooms"); // zones and go-to need the flat map
  S.viewMode = mode;
  try {
    localStorage.setItem("view", mode);
  } catch {
    // storage blocked
  }
  syncViewChrome();
  if (S.map) mapImg.src = viewImage();
  refreshMapOverlays();
  if (mode === "3d") void show3D();
  if (mode === "fresh") void loadFreshness();
  if (mode === "suspects") void loadSuspects();
}

/** The base image for the current flat view. */
export function viewImage(): string {
  if (!S.map) return "";
  if (S.viewMode === "plan") return planImage();
  if (S.viewMode === "fresh") return freshImage();
  if (S.viewMode === "suspects") return suspectsImage();
  return colourImage() || S.map.base;
}

export function syncViewChrome(): void {
  const is3d = S.viewMode === "3d";
  $$("#view-modes button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === S.viewMode);
    b.setAttribute("aria-pressed", String(b.dataset.view === S.viewMode));
  });
  inner.classList.toggle("plan", S.viewMode === "plan");
  inner.classList.toggle("fresh", S.viewMode === "fresh");
  inner.classList.toggle("suspects", S.viewMode === "suspects");
  renderFreshPanel();
  renderSusPanel();
  stage.classList.toggle("is-3d", is3d);
  $("#map3d").hidden = !is3d;
  map3d?.setActive(is3d);
  if (S.map) applyView();
  for (const b of $$<HTMLButtonElement>('#map-tools [data-tool="zone"], #map-tools [data-tool="goto"]')) {
    b.disabled = is3d;
    b.title = is3d ? "Switch to 2D to use this" : b.dataset.tool === "zone" ? "Draw a zone" : "Send robot to a spot";
  }
}

/* ---- 3D view (three.js, loaded the first time you open it) ---- */

let map3d: Map3D | null = null;
let map3dLoading: Promise<void> | null = null;

export const get3D = (): Map3D | null => map3d;

/** Fetch the 3D code while the browser is idle, so switching to 3D doesn't wait for it. */
export function preload3D(): void {
  const load = () => void import("../map3d").catch(() => {});
  if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 10_000 });
  else setTimeout(load, 3000);
}

export async function show3D(): Promise<void> {
  try {
    map3dLoading ??= import("../map3d").then(({ createMap3D }) => {
      map3d = createMap3D($("#map3d"), {
        roomAt: (p) => roomAt(p),
        onRoomClick: (id) => toggleRoom(id),
        onHover: (id) => {
          S.hover = id;
          drawSelection();
        },
        insets: () => ({ ...stagePadding(), buttons: buttonsReach() }),
      });
    });
    await map3dLoading;
  } catch {
    map3dLoading = null;
    toast("3D isn't available in this browser", true);
    setViewMode("2d");
    return;
  }
  if (S.viewMode !== "3d" || !map3d) return;
  map3d.setActive(true);
  sync3D(true);
}

// Keep the 3D scene in step with the app: the map itself when it changes,
// and the labels, selection and walls/zones whenever the overlays redraw.
export function sync3D(mapChanged = false): void {
  const m = S.map;
  if (!map3d || S.viewMode !== "3d" || !m || !S.mask) return;
  if (mapChanged) map3d.setMap(m, S.mask, m.mask, homeBox(), colourImage() || m.base);
  map3d.setLabels(m.rooms.map((r) => ({ id: r.id, name: r.name, x: r.x, y: r.y, sel: S.selected.includes(r.id) })));
  map3d.setRestrictions(m.frame ? m.restrictions.map((r) => ({ type: r.type, pts: itemPx(r) })) : []);
  const markers: Marker3D[] = groupObstacles(m.obstacles ?? [], m.scale).map((g) => ({
    x: g.x, y: g.y, cls: g.kind, title: g.title, icon: OBSTACLE_ICON[g.kind], count: g.count,
  }));
  if (m.goto) markers.push({ x: m.goto[0], y: m.goto[1], cls: "goto", title: "Where the robot is heading", icon: "target" });
  map3d.setThings(m, markers);
  map3d.setLayers(S.layers);
  map3d.setSelectionCanvas(selCanvas);
}

// Redraw what's drawn with theme colours when the theme changes (web/theme.ts).
document.addEventListener("themechange", () => {
  if (S.map && S.viewMode !== "3d") mapImg.src = viewImage();
  if (S.mask) drawSelection();
  refreshMapOverlays(); // the room colours in the labels
  map3d?.applyTheme();
  sync3D(true); // its floor is the colour map, in the new theme's colours
});
