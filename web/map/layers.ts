// What's drawn over the floor in the 2D and plan views: the cleaning path (and
// where it mopped), carpets, obstacles the robot spotted, no-carpet zones, the
// zone being cleaned and the go-to target. The Layers menu switches them on and off.

import { api, devicePath } from "../api";
import { $, $$, closest, cssVar, esc, icon, pct } from "../dom";
import { S, type Layers } from "../state";
import type { Obstacle, ObstacleKind, Polyline } from "../types";
import { inner, mapImg } from "./elements";
import { planImage, sync3D } from "./views";

const infoSvg = $<SVGSVGElement>("#map-info");
const thingsEl = $("#map-things");
const carpetsImg = $<HTMLImageElement>("#map-carpets");

export const OBSTACLE_ICON: Record<ObstacleKind, string> = {
  cable: "cords-wires",
  pet_waste: "paw",
  shoes: "shoe",
  clothes: "shirt",
  pet: "paw",
  furniture: "furniture",
  obstacle: "obstacle-cone",
};

function obstacleIcon(kind: ObstacleKind, label: string): string {
  if (/^pedestal$/i.test(label.trim())) return "pedestal";
  if (/^(cable|cords\/wires|cords and wires|extension cord)$/i.test(label.trim())) return "cords-wires";
  if (/^(furniture|easily trapped furniture)$/i.test(label.trim())) return "furniture";
  return OBSTACLE_ICON[kind];
}

export interface ObstacleGroup {
  x: number;
  y: number;
  kind: ObstacleKind;
  count: number;
  title: string;
  photoIds: string[];
  objectIds: number[];
  confidence: number | null;
  ignored: boolean;
  label: string;
}

/** Merge nearby detections only when they represent the same object type. */
export function groupObstacles(obstacles: Obstacle[], scale: number): ObstacleGroup[] {
  const radius = (0.5 / 0.05) * scale;
  const groups: { xs: number; ys: number; key: string; items: Obstacle[] }[] = [];
  for (const o of obstacles) {
    const labelKey = o.label.trim().toLocaleLowerCase();
    const typeKey = Number.isInteger(o.type) ? String(o.type) : labelKey;
    const key = `${o.kind}:${typeKey}`;
    const g = groups.find((g) => g.key === key && Math.hypot(g.xs / g.items.length - o.x, g.ys / g.items.length - o.y) <= radius);
    if (g) {
      g.items.push(o);
      g.xs += o.x;
      g.ys += o.y;
    } else groups.push({ xs: o.x, ys: o.y, key, items: [o] });
  }
  return groups.map(({ xs, ys, items }) => {
    const kind = items[0].kind;
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.label, (counts.get(i.label) ?? 0) + 1);
    let title = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ");
    title += kind === "obstacle"
      ? " – Roborock detected something here and steered around it, but did not provide a name"
      : " – detected and avoided by the robot";
    const photoIds = [...new Set(items.map((i) => i.photo_id).filter((id): id is string => Boolean(id)))];
    if (photoIds.length) title += photoIds.length > 1 ? `. Tap to view ${photoIds.length} photos` : ". Tap to view the photo";
    const confidenceValues = items.map((i) => i.confidence).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const objectIds = [...new Set(items.map((i) => i.type).filter((id): id is number => Number.isInteger(id)))];
    return {
      x: xs / items.length, y: ys / items.length, kind, count: items.length, title, photoIds,
      objectIds, confidence: confidenceValues.length ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length : null,
      ignored: items.every((i) => i.ignored), label: [...new Set(items.map((i) => i.label))].join(", "),
    };
  });
}

function spreadNearbyMarkerOffsets(groups: ObstacleGroup[]): { x: number; y: number }[] {
  const rect = inner.getBoundingClientRect();
  const offsets = groups.map(() => ({ x: 0, y: 0 }));
  if (!rect.width || !rect.height || groups.length < 2) return offsets;
  const centers = groups.map((g) => ({ x: (g.x / (S.map?.width ?? 1)) * rect.width, y: (g.y / (S.map?.height ?? 1)) * rect.height }));
  const visited = new Set<number>();
  for (let i = 0; i < groups.length; i++) {
    if (visited.has(i)) continue;
    const cluster: number[] = [];
    const queue = [i];
    visited.add(i);
    while (queue.length) {
      const current = queue.pop()!;
      cluster.push(current);
      for (let j = 0; j < groups.length; j++) {
        if (visited.has(j)) continue;
        if (Math.hypot(centers[current].x - centers[j].x, centers[current].y - centers[j].y) < 34) {
          visited.add(j);
          queue.push(j);
        }
      }
    }
    if (cluster.length < 2) continue;
    const radius = Math.max(20, Math.min(34, cluster.length * 8));
    cluster.forEach((groupIndex, slot) => {
      const angle = -Math.PI / 2 + (slot * 2 * Math.PI) / cluster.length;
      offsets[groupIndex] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
  }
  return offsets;
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

  const marker = (cls: string, x: number, y: number, title: string, ic: string, count = 1, photoIds: string[] = [], detail?: { objectIds: number[]; confidence: number | null; ignored: boolean; label: string }, offset = { x: 0, y: 0 }) =>
    `<span class="thing ${cls}" role="button" tabindex="0" data-map-info="${esc(title)}" ${photoIds.length ? `data-photo-ids="${esc(JSON.stringify(photoIds))}"` : ""} ${detail ? `data-obstacle-detail="${esc(JSON.stringify(detail))}"` : ""} aria-label="${esc(title)}" style="left:${pct(x, m.width)};top:${pct(y, m.height)};--thing-offset-x:${offset.x}px;--thing-offset-y:${offset.y}px" title="${esc(title)}">${icon(ic)}${count > 1 ? `<b class="count">${count}</b>` : ""}</span>`;
  const obstacleGroups = groupObstacles(m.obstacles ?? [], m.scale);
  const obstacleOffsets = spreadNearbyMarkerOffsets(obstacleGroups);
  thingsEl.innerHTML =
    obstacleGroups.map((g, index) => marker(g.kind, g.x, g.y, g.title, obstacleIcon(g.kind, g.label), g.count, g.photoIds, g, obstacleOffsets[index])).join("") +
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
document.body.append(objectInfo);
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
  let detail: { objectIds?: number[]; confidence?: number | null; ignored?: boolean; label?: string } = {};
  try {
    detail = JSON.parse(marker.dataset.obstacleDetail ?? "{}");
  } catch {
    // Ignore malformed marker data.
  }
  const photos = photoIds.map((photoId, index) => `<img class="obstacle-photo" src="${devicePath("obstacle-photo")}?photo_id=${encodeURIComponent(photoId)}" alt="Photo of detected obstacle ${index + 1} of ${photoIds.length}">`).join("");
  const obstacleKind = (Object.keys(OBSTACLE_ICON) as ObstacleKind[]).find((kind) => marker.classList.contains(kind)) ?? "obstacle";
  const rawLabel = (detail.label || "Detected object").trim();
  const isPedestal = /^pedestal$/i.test(rawLabel);
  const isFurniture = /^(furniture|easily trapped furniture)$/i.test(rawLabel) || obstacleKind === "furniture";
  const isCable = /^(cable|cords\/wires|cords and wires|extension cord)$/i.test(rawLabel) || obstacleKind === "cable";
  const label = isPedestal ? "Pedestal" : obstacleKind === "obstacle" ? "Obstacle" : isFurniture ? "Easily trapped furniture" : isCable ? "Cords/wires" : rawLabel;
  const categoryIcon = obstacleIcon(obstacleKind, label);
  const categoryKind = isPedestal ? "pedestal" : categoryIcon === "cords-wires" ? "cable" : categoryIcon === "furniture" ? "furniture" : obstacleKind;
  const confidence = typeof detail.confidence === "number" && Number.isFinite(detail.confidence)
    ? `Confidence:${Math.round(Math.max(0, Math.min(100, detail.confidence)))}%`
    : "";
  const isAi = (detail.objectIds?.length ?? 0) > 0 || Boolean(confidence);
  const state = detail.ignored ? "Ignored" : "Avoided";
  const explanation = isPedestal
    ? "Pedestal avoided preventing entrapment."
    : obstacleKind === "obstacle"
      ? "Potential ground obstacles detected by the LiDAR sensor and avoided in advance."
      : isFurniture
        ? "Furniture with a crossbar, i.e., cantilever chair, avoided preventing entrapment."
        : isCable
          ? "Cords/wires avoided, preventing tangling. Long, thin cords may still be tangled."
          : "";
  const canIgnore = photoIds.length > 0 && (detail.objectIds?.length ?? 0) > 0 && !detail.ignored;
  objectInfo.innerHTML = `<div class="obstacle-sheet-handle" aria-hidden="true"><span></span></div><div class="obstacle-sheet-body"><div class="obstacle-title-row"><div class="obstacle-category-icon type-${categoryKind}" aria-hidden="true">${icon(categoryIcon, "obstacle-category-glyph")}</div><div class="obstacle-heading-copy"><div class="obstacle-info-title">${esc(label)}</div><div class="obstacle-info-badges">${isAi ? '<span class="obstacle-ai-pill">AI</span>' : ""}<span class="obstacle-state">${esc(state)}</span>${confidence ? `<span class="obstacle-confidence">${esc(confidence)}</span>` : ""}</div></div></div>${explanation ? `<div class="obstacle-info-description">${esc(explanation)}</div>` : ""}${photos ? `<div class="obstacle-photos">${photos}</div><div class="obstacle-photo-error" hidden>Photo unavailable</div>` : ""}${canIgnore ? '<button class="obstacle-ignore" type="button">No need to avoid, ignore?</button><div class="obstacle-ignore-status" aria-live="polite"></div>' : ""}</div>`;
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
  const ignoreButton = objectInfo.querySelector<HTMLButtonElement>(".obstacle-ignore");
  ignoreButton?.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!ignoreButton || !detail.objectIds?.length) return;
    ignoreButton.disabled = true;
    ignoreButton.textContent = "Updating…";
    const status = objectInfo.querySelector<HTMLElement>(".obstacle-ignore-status");
    try {
      await api(devicePath("obstacle-ignore"), { method: "POST", body: { photo_ids: photoIds } });
      ignoreButton.remove();
      const statusBadge = objectInfo.querySelector<HTMLElement>(".obstacle-state");
      if (statusBadge) statusBadge.textContent = "Ignored";
      if (status) status.textContent = "Roborock has been asked to ignore this object.";
    } catch (error) {
      ignoreButton.disabled = false;
      ignoreButton.textContent = "No need to avoid, ignore?";
      if (status) status.textContent = error instanceof Error ? error.message : "Could not update the obstacle.";
    }
  });
  activeMarker = marker;
  objectInfo.hidden = false;
  objectInfo.style.removeProperty("left");
  objectInfo.style.removeProperty("top");
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
