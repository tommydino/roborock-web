// The map's own colours: each room gets a jewel tone from the theme's palette (neighbouring
// rooms always differ), and the 2D colour map and the floor plan are painted here from the
// 5 cm room mask, so both themes get real colours instead of a filtered server image.

import { cssVar, hexRgb } from "../dom";
import { S } from "../state";

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const PALETTE_SIZE = 12;

/* ---- room colours ---- */

let roomCache = { key: "", colours: new Map<number, RGB>() };

/** Each room's colour. Rooms are taken in id order and given the first palette colour, from
 *  one picked by their id, that none of their neighbours already has. */
export function roomColours(): Map<number, RGB> {
  const mask = S.mask;
  const m = S.map;
  if (!mask || !m) return new Map();
  const palette = Array.from({ length: PALETTE_SIZE }, (_, i) => hexRgb(cssVar(`--room-${i}`) || "#7c9cff"));
  const key = `${m.mask.length}:${m.mask.slice(-48)}:${palette.join()}`;
  if (roomCache.key === key) return roomCache.colours;

  const { w, h, data } = mask;
  const near = new Map<number, Set<number>>(); // rooms that touch, through a wall up to 3 blocks thick
  const link = (a: number, b: number) => {
    if (!a || !b || a === b) return;
    (near.get(a) ?? near.set(a, new Set()).get(a)!).add(b);
    (near.get(b) ?? near.set(b, new Set()).get(b)!).add(a);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4];
      if (!a) continue;
      for (let d = 1; d <= 4; d++) {
        if (x + d < w) link(a, data[(y * w + x + d) * 4]);
        if (y + d < h) link(a, data[((y + d) * w + x) * 4]);
      }
    }
  }
  const colours = new Map<number, RGB>();
  const taken = new Map<number, number>();
  for (const id of m.rooms.map((r) => r.id).sort((a, b) => a - b)) {
    const used = new Set([...(near.get(id) ?? [])].map((n) => taken.get(n)).filter((v) => v != null));
    let pick = id % PALETTE_SIZE;
    for (let k = 0; k < PALETTE_SIZE && used.has(pick); k++) pick = (pick + 1) % PALETTE_SIZE;
    taken.set(id, pick);
    colours.set(id, palette[pick]);
  }
  roomCache = { key, colours };
  return colours;
}

export const roomCss = (id: number): string | null => {
  const c = roomColours().get(id);
  return c ? `rgb(${c.join(",")})` : null;
};

/* ---- shared drawing helpers ---- */

export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const colour = (name: string, fallback: string): RGBA => [...hexRgb(cssVar(name) || fallback), 255];

/** One pixel per block, scaled up with crisp edges to the map's size. */
function upscale(small: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const big = canvas(width, height);
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, width, height);
  return big;
}

const isRoomFloor = (data: Uint8ClampedArray, o: number) => data[o + 3] && data[o] && data[o + 1] !== 1 && data[o + 1] !== 2;

/* ---- the 2D colour map ---- */

let colourCache = { key: "", url: "" };

/** Rooms in jewel tones, a little darker towards their walls so each one reads as a space,
 *  ink walls, and a soft shadow (light) or a glow of the rooms' own colours (dark) round the
 *  home. Carpets, the path and everything else are overlays. */
export function colourImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const rooms = roomColours();
  const c = {
    wall: colour("--map-wall", "#232733"),
    floor: colour("--map-floor", "#e7e3db"),
    furniture: colour("--map-furniture", "#cfc9bf"),
    edge: cssVar("--map-edge-shade") || "rgba(15, 18, 30, 0.38)",
    halo: cssVar("--map-halo") || "rgba(15, 23, 42, 0.22)",
    glow: Number(cssVar("--map-glow") || "0"),
  };
  const key = [m.mask.length, m.mask.slice(-48), m.width, [...rooms.values()].join(), c.wall.join(), c.floor.join(), c.edge, c.halo, c.glow].join(":");
  if (colourCache.key === key) return colourCache.url;

  const { w, h, data } = mask;
  const fill = canvas(w, h); // floors: rooms in their colours, the rest neutral
  const fimg = fill.getContext("2d")!.createImageData(w, h);
  const ink = canvas(w, h); // walls
  const iimg = ink.getContext("2d")!.createImageData(w, h);
  const outside = canvas(w, h); // everything that isn't room floor, to shade rooms from
  const oimg = outside.getContext("2d")!.createImageData(w, h);
  for (let o = 0; o < data.length; o += 4) {
    if (!data[o + 3]) {
      oimg.data.set([0, 0, 0, 255], o);
      continue;
    }
    const kind = data[o + 1];
    if (kind === 1) {
      iimg.data.set(c.wall, o);
      oimg.data.set([0, 0, 0, 255], o);
      continue;
    }
    const room = data[o] ? rooms.get(data[o]) : undefined;
    if (kind === 2) fimg.data.set(c.furniture, o);
    else fimg.data.set(room ? [...room, 255] : c.floor, o);
    if (!isRoomFloor(data, o)) oimg.data.set([0, 0, 0, 255], o);
  }
  fill.getContext("2d")!.putImageData(fimg, 0, 0);
  ink.getContext("2d")!.putImageData(iimg, 0, 0);
  outside.getContext("2d")!.putImageData(oimg, 0, 0);

  const W = m.width;
  const H = m.height;
  const floors = upscale(fill, W, H);
  const fctx = floors.getContext("2d")!;
  // Shade rooms towards their walls: the outside casts a soft inner shadow onto the floors.
  fctx.save();
  fctx.globalCompositeOperation = "source-atop";
  fctx.shadowColor = c.edge;
  fctx.shadowBlur = 5 * m.scale;
  fctx.drawImage(upscale(outside, W, H), 0, 0);
  fctx.restore();
  // ...but put the outside itself back: only the shadow should land.
  const shaded = canvas(W, H);
  const sctx = shaded.getContext("2d")!;
  sctx.drawImage(floors, 0, 0);
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(upscale(fill, W, H), 0, 0);
  sctx.globalCompositeOperation = "source-over";
  sctx.drawImage(upscale(ink, W, H), 0, 0);

  // Round the home: a soft drop shadow in the light theme, the rooms' own glow in the dark.
  const out = canvas(W, H);
  const ctx = out.getContext("2d")!;
  ctx.save();
  if (c.glow > 0) {
    ctx.globalAlpha = c.glow;
    ctx.filter = `blur(${6 * m.scale}px)`;
    ctx.drawImage(shaded, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
  } else {
    ctx.shadowColor = c.halo;
    ctx.shadowBlur = 6 * m.scale;
    ctx.shadowOffsetY = 1.5 * m.scale;
    ctx.drawImage(shaded, 0, 0);
  }
  ctx.restore();
  ctx.drawImage(shaded, 0, 0);

  colourCache = { key, url: out.toDataURL("image/png") };
  return colourCache.url;
}

/* ---- the floor plan ---- */

let planCache = { key: "", url: "" };

/** A blueprint: theme paper with a 1 m grid, each room washed in its colour and outlined in
 *  it, crisp walls, and carpets hatched. */
export function planImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const rooms = roomColours();
  const paper = colour("--plan-paper", "#f7f9fc");
  const wall = colour("--plan-wall", "#1b2230");
  const furniture = colour("--plan-furniture", "#dfe3ea");
  const wash = Number(cssVar("--plan-wash") || "0.14");
  const key = [m.mask.length, m.mask.slice(-64), m.width, paper.join(), wall.join(), [...rooms.values()].join(), wash, S.layers.carpets].join(":");
  if (planCache.key === key) return planCache.url;

  const { w, h, data } = mask;
  const small = canvas(w, h);
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  const rugs = canvas(w, h);
  const rugImg = rugs.getContext("2d")!.createImageData(w, h);
  const mix = (a: RGBA, b: RGB, t: number): RGBA => [0, 1, 2].map((i) => Math.round(a[i] * (1 - t) + b[i] * t)).concat(255) as RGBA;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (!data[o + 3]) continue;
      const kind = data[o + 1];
      const id = data[o];
      const rc = id ? rooms.get(id) : undefined;
      let px: RGBA = kind === 1 ? wall : kind === 2 ? furniture : rc ? mix(paper, rc, wash) : paper;
      // A room's outline in its own colour, where it meets anything else.
      if (rc && kind !== 1) {
        const other = (dx: number, dy: number) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true;
          const q = (ny * w + nx) * 4;
          return data[q] !== id || data[q + 1] === 1;
        };
        if (other(1, 0) || other(-1, 0) || other(0, 1) || other(0, -1)) px = [...rc, 255];
      }
      img.data.set(px, o);
      if (data[o + 2] && kind !== 1 && S.layers.carpets) rugImg.data.set([0, 0, 0, 255], o);
    }
  }
  sctx.putImageData(img, 0, 0);
  rugs.getContext("2d")!.putImageData(rugImg, 0, 0);

  const big = upscale(small, m.width, m.height);
  const ctx = big.getContext("2d")!;

  // Carpets: diagonal hatching.
  const hatch = upscale(rugs, big.width, big.height);
  const hctx = hatch.getContext("2d")!;
  hctx.globalCompositeOperation = "source-in";
  hctx.strokeStyle = cssVar("--plan-hatch") || "rgba(120,100,70,.2)";
  hctx.lineWidth = 1.5;
  hctx.beginPath();
  for (let d = -big.height; d < big.width; d += 9) {
    hctx.moveTo(d, big.height);
    hctx.lineTo(d + big.height, 0);
  }
  hctx.stroke();
  ctx.drawImage(hatch, 0, 0);

  // A 1 m grid, aligned to the robot's coordinates, only on mapped floor.
  const f = m.frame;
  if (f) {
    const step = (1000 / f.mm) * f.scale; // px per metre
    const blocksPerM = 1000 / f.mm;
    const x0 = (Math.ceil(f.left / blocksPerM) * blocksPerM - f.left) * f.scale;
    const y0 = ((f.top + f.height) % blocksPerM) * f.scale;
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.strokeStyle = cssVar("--plan-grid") || "rgba(43,51,64,.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x < big.width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, big.height);
    }
    for (let y = y0; y < big.height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(big.width, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Lift the walls off the paper a touch.
  const glow = cssVar("--plan-glow");
  if (glow) {
    const lifted = canvas(big.width, big.height);
    const lctx = lifted.getContext("2d")!;
    lctx.shadowColor = glow;
    lctx.shadowBlur = 3 * m.scale;
    lctx.drawImage(big, 0, 0);
    planCache = { key, url: lifted.toDataURL("image/png") };
    return planCache.url;
  }
  planCache = { key, url: big.toDataURL("image/png") };
  return planCache.url;
}
