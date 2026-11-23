// What's drawn over the floor in the 2D and plan views: the cleaning path (and
// where it mopped), carpets, obstacles the robot spotted, no-carpet zones, the
// zone being cleaned and the go-to target. The Layers menu switches them on and off.

import { devicePath } from "../api";
import { $, $$, closest, cssVar, esc, icon, pct } from "../dom";
import { S, type Layers } from "../state";
import type { Obstacle, ObstacleKind, Polyline } from "../types";
import { inner, mapImg, stage } from "./elements";
import { planImage, sync3D } from "./views";

const infoSvg = $<SVGSVGElement>("#map-info");
const thingsEl = $("#map-things");
const carpetsImg = $<HTMLImageElement>("#map-carpets");

export const OBSTACLE_ICON: Record<ObstacleKind, string> = {
  cable: "plug",
  pet_waste: "paw",
  shoes: "shoe",
  clothes: "shirt",
  pet: "paw",
  furniture: "box",
  obstacle: "dot", // something it steered around, type unknown
};

export interface ObstacleGroup {
  x: number;
  y: number;
  kind: ObstacleKind;
  count: number;
  title: string;
  photoIds: string[];
}

/** Merge obstacles within half a metre into one marker, so a wall of bumps doesn't pile up. */
export function groupObstacles(obstacles: Obstacle[], scale: number): ObstacleGroup[] {
  const radius = (0.5 / 0.05) * scale;
  const groups: { xs: number; ys: number; items: Obstacle[] }[] = [];
  for (const o of obstacles) {
    const g = groups.find((g) => Math.hypot(g.xs / g.items.length - o.x, g.ys / g.items.length - o.y) <= radius);
    if (g) {
      g.items.push(o);
      g.xs += o.x;
      g.ys += o.y;
    } else groups.push({ xs: o.x, ys: o.y, items: [o] });
  }
  return groups.map(({ xs, ys, items }) => {
    // Show a recognised type (a cable, shoes…) when the group has one.
    const kind = (items.find((i) => i.kind !== "obstacle") ?? items[0]).kind;
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.label, (counts.get(i.label) ?? 0) + 1);
    let title = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ");
    title += kind === "obstacle"
      ? " – Roborock detected something here and steered around it, but did not provide a name"
      : " – detected and avoided by the robot";
    const photoIds = [...new Set(items.map((i) => i.photo_id).filter((id): id is string => Boolean(id)))];
    if (photoIds.length) title += photoIds.length > 1 ? `. Tap to view ${photoIds.length} photos` : ". Tap to view the photo";
    return { x: xs / items.length, y: ys / items.length, kind, count: items.length, title, photoIds };
  });
}

const points = (line: Polyline) => line.map(([x, y]) => `${x},${y}`).join(" ");

/** Redraw everything over the floor. Call when the map or the layers change. */
export function renderThings(): void {
  const m = S.map;
  if (!m) return;
  objectInfo.hidden = true;
  activeMarker = null;
  infoSvg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  let svg = "";
  // A hairline at half strength: dense criss-cross runs build up softly instead of
  // turning into a white blanket. Mopped stretches get a faint blue tint on top.
  for (const line of m.path ?? []) svg += `<polyline class="path" points="${points(line)}"/>`;
  // The newest stretch, drawn brighter on top, so you can see where it's heading.
  const newest = m.path?.[m.path.length - 1];
  if (newest && newest.length > 1) svg += `<polyline class="path path-head" points="${points(newest.slice(-40))}"/>`;
  for (const line of m.mop_path ?? []) svg += `<polyline class="mop-path" points="${points(line)}"/>`;
  for (const area of m.no_carpet ?? []) svg += `<polygon class="no-carpet" points="${points(area)}"/>`;
  for (const [x0, y0, x1, y1] of m.zones ?? []) {
    svg += `<rect class="active-zone" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}"/>`;
  }
  for (const line of m.goto_path ?? []) svg += `<polyline class="goto-route" points="${points(line)}"/>`;
  infoSvg.innerHTML = svg;

  const marker = (cls: string, x: number, y: number, title: string, ic: string, count = 1, photoIds: string[] = []) =>
    `<span class="thing ${cls}" role="button" tabindex="0" data-map-info="${esc(title)}" ${photoIds.length ? `data-photo-ids="${esc(JSON.stringify(photoIds))}"` : ""} aria-label="${esc(title)}" style="left:${pct(x, m.width)};top:${pct(y, m.height)}" title="${esc(title)}">${icon(ic)}${count > 1 ? `<b class="count">${count}</b>` : ""}</span>`;
  thingsEl.innerHTML =
    groupObstacles(m.obstacles ?? [], m.scale).map((g) => marker(g.kind, g.x, g.y, g.title, OBSTACLE_ICON[g.kind], g.count, g.photoIds)).join("") +
    (m.goto ? marker("goto", m.goto[0], m.goto[1], "Where the robot is heading", "target") : "");

  carpetsImg.src = carpetImage() || "data:,";
  applyLayers();
}

/** Show or hide layers without redrawing them. */
export function applyLayers(): void {
  const l = S.layers;
  inner.classList.toggle("hide-path", !l.path);
  inner.classList.toggle("hide-carpets", !l.carpets);
  inner.classList.toggle("hide-obstacles", !l.obstacles);
  inner.classList.toggle("hide-restrictions", !l.restrictions);
  $$<HTMLInputElement>("#layers-pop [data-layer]").forEach((input) => {
    input.checked = l[input.dataset.layer as keyof Layers];
  });
}

function setLayer(key: keyof Layers, on: boolean): void {
  S.layers[key] = on;
  try {
    localStorage.setItem("layers", JSON.stringify(S.layers));
  } catch {
    // storage blocked
  }
  applyLayers();
  // The plan bakes its carpet hatching into the drawing; the 3D view has its own layers.
  if (key === "carpets" && S.map && S.viewMode === "plan") mapImg.src = planImage();
  sync3D(true);
}

// Carpets on the colour map: soft diagonal hatching over every carpet pixel,
// drawn from the room mask and kept until the layout changes.
let carpetCache = { key: "", url: "" };

function carpetImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const key = `${m.mask.length}:${m.mask.slice(-64)}:${m.width}:${cssVar("--carpet-hatch")}`;
  if (carpetCache.key === key) return carpetCache.url;
  const { w, h, data } = mask;
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  let any = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] && data[i + 2] && data[i + 1] !== 1) {
      img.data.set([0, 0, 0, 255], i);
      any = true;
    }
  }
  if (!any) {
    carpetCache = { key, url: "" };
    return "";
  }
  sctx.putImageData(img, 0, 0);
  const big = document.createElement("canvas");
  big.width = m.width;
  big.height = m.height;
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = cssVar("--carpet-tint") || "rgba(255,248,235,.3)";
  ctx.fillRect(0, 0, big.width, big.height);
  ctx.globalCompositeOperation = "source-atop";
  ctx.strokeStyle = cssVar("--carpet-hatch") || "rgba(80,52,24,.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let d = -big.height; d < big.width; d += 7) {
    ctx.moveTo(d, big.height);
    ctx.lineTo(d + big.height, 0);
  }
  ctx.stroke();
  carpetCache = { key, url: big.toDataURL("image/png") };
  return carpetCache.url;
}

/* ---- the Layers menu ---- */

const pop = $("#layers-pop");
const objectInfo = document.createElement("div");
objectInfo.className = "map-object-info";
objectInfo.hidden = true;
objectInfo.setAttribute("role", "status");
stage.append(objectInfo);
const photoViewer = document.createElement("dialog");
photoViewer.className = "obstacle-photo-viewer";
photoViewer.setAttribute("aria-label", "Obstacle photo");
photoViewer.innerHTML = `<button class="obstacle-photo-close" type="button" aria-label="Close photo">&times;</button><button class="obstacle-photo-prev" type="button" aria-label="Previous photo">&#8249;</button><img alt=""><button class="obstacle-photo-next" type="button" aria-label="Next photo">&#8250;</button><div class="obstacle-photo-count"></div>`;
document.body.append(photoViewer);
const viewerImage = photoViewer.querySelector<HTMLImageElement>("img")!;
const viewerCount = photoViewer.querySelector<HTMLElement>(".obstacle-photo-count")!;
const previousPhoto = photoViewer.querySelector<HTMLButtonElement>(".obstacle-photo-prev")!;
const nextPhoto = photoViewer.querySelector<HTMLButtonElement>(".obstacle-photo-next")!;
let viewerSources: string[] = [];
let viewerIndex = 0;
let activeMarker: HTMLElement | null = null;

function showViewerPhoto(index: number): void {
  viewerIndex = (index + viewerSources.length) % viewerSources.length;
  viewerImage.src = viewerSources[viewerIndex];
  viewerImage.alt = `Photo of detected obstacle ${viewerIndex + 1} of ${viewerSources.length}`;
  viewerCount.textContent = viewerSources.length > 1 ? `${viewerIndex + 1} / ${viewerSources.length}` : "";
  previousPhoto.hidden = nextPhoto.hidden = viewerSources.length < 2;
}

function openPhoto(images: HTMLImageElement[], index: number): void {
  viewerSources = images.map((image) => image.currentSrc || image.src);
  if (!viewerSources.length) return;
  showViewerPhoto(index);
  photoViewer.showModal();
}

photoViewer.querySelector(".obstacle-photo-close")?.addEventListener("click", () => photoViewer.close());
previousPhoto.addEventListener("click", () => showViewerPhoto(viewerIndex - 1));
nextPhoto.addEventListener("click", () => showViewerPhoto(viewerIndex + 1));
photoViewer.addEventListener("click", (e) => {
  if (e.target === photoViewer) photoViewer.close();
});
photoViewer.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" && viewerSources.length > 1) showViewerPhoto(viewerIndex - 1);
  if (e.key === "ArrowRight" && viewerSources.length > 1) showViewerPhoto(viewerIndex + 1);
});
photoViewer.addEventListener("close", () => {
  viewerImage.removeAttribute("src");
  viewerSources = [];
});

function showObjectInfo(marker: HTMLElement): void {
  const text = marker.dataset.mapInfo;
  if (!text) return;
  if (!objectInfo.hidden && activeMarker === marker) {
    objectInfo.hidden = true;
    activeMarker = null;
    return;
  }
  let photoIds: string[] = [];
  try {
    photoIds = JSON.parse(marker.dataset.photoIds ?? "[]");
  } catch {
    // Ignore malformed marker data.
  }
  const photos = photoIds.map((photoId, index) => `<img class="obstacle-photo" src="${devicePath("obstacle-photo")}?photo_id=${encodeURIComponent(photoId)}" alt="Photo of detected obstacle ${index + 1} of ${photoIds.length}">`).join("");
  objectInfo.innerHTML = `<div>${esc(text)}</div>${photos ? `<div class="obstacle-photos">${photos}</div><div class="obstacle-photo-error" hidden>Photo unavailable</div>` : ""}`;
  const images = $$<HTMLImageElement>(".obstacle-photo", objectInfo);
  images.forEach((image, index) => {
    image.addEventListener("error", () => {
      image.hidden = true;
      if (images.every((item) => item.hidden)) {
        const error = objectInfo.querySelector<HTMLElement>(".obstacle-photo-error");
        if (error) error.hidden = false;
      }
    }, { once: true });
    image.addEventListener("click", () => openPhoto(images, index));
  });
  activeMarker = marker;
  objectInfo.hidden = false;
  const target = marker.getBoundingClientRect();
  const box = stage.getBoundingClientRect();
  objectInfo.style.left = `${Math.max(76, Math.min(box.width - 76, target.left + target.width / 2 - box.left))}px`;
  objectInfo.style.top = `${Math.max(12, target.top - box.top - 10)}px`;
}

document.addEventListener("click", (e) => {
  const marker = closest<HTMLElement>(e.target, ".thing[data-map-info]");
  if (marker) {
    e.stopPropagation();
    showObjectInfo(marker);
  } else if (!closest(e.target, ".map-object-info")) {
    objectInfo.hidden = true;
    activeMarker = null;
  }
});

document.addEventListener("keydown", (e) => {
  const marker = closest<HTMLElement>(e.target, ".thing[data-map-info]");
  if (marker && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    showObjectInfo(marker);
  }
  if (e.key === "Escape") {
    objectInfo.hidden = true;
    activeMarker = null;
  }
});

$("#layers-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  pop.hidden = !pop.hidden;
  applyLayers();
});

pop.addEventListener("change", (e) => {
  const input = closest<HTMLInputElement>(e.target, "[data-layer]");
  if (input) setLayer(input.dataset.layer as keyof Layers, input.checked);
});

document.addEventListener("click", (e) => {
  if (!pop.hidden && !closest(e.target, "#layers-pop, #layers-btn")) pop.hidden = true;
});
