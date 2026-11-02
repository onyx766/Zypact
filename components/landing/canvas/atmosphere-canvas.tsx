"use client";

import { useRef } from "react";

import { clamp, createNoise3D, hashSeed, mulberry32 } from "./noise";
import {
  useCanvasLoop,
  type CanvasEnvironment,
  type CanvasFrame,
  type CanvasScene,
  type CanvasSize,
} from "./use-canvas-loop";

/**
 * The living backdrop behind the whole cream page: one fixed, viewport-sized
 * canvas under every section (`position: fixed; inset: 0; z-index: 0`,
 * pointer-events none). Content above it must sit at z-index 1 or higher.
 *
 * Three quiet layers:
 * - colour fields: amber, sea, mist and peach glows drifting on slow
 *   Lissajous paths, painted into a tiny buffer and upscaled (they are pure
 *   blur, so this costs one full-screen blit instead of four);
 * - topographic contours: marching squares over a domain-warped 3D noise
 *   field that evolves with time, scrolls at a fraction of the page speed
 *   (so it reads as far behind the content) and swells like a lens around
 *   the pointer;
 * - evidence points: a sparse drift of dots that connect with hairlines
 *   near the pointer (or near a slow wandering focus on touch screens).
 *
 * Every stroke stays at 5-9 % ink, so body text over it keeps its contrast.
 * Capped at 30 fps and a 1.5 device pixel ratio; the grid, point count and
 * pixel budget scale with the viewport, and touch screens do less.
 */
export function AtmosphereCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasLoop(ref, createAtmosphereScene, {
    maxDpr: 1.5,
    maxPixels: 2_400_000,
    fps: 30,
    rootMargin: "0px",
    staticTime: 0,
  });

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        display: "block",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

/* =============================================================== Settings */

const TAU = Math.PI * 2;
// Ink #13302C and deep teal #144640. Built once: no strings per frame.
const CONTOUR_MINOR = "rgba(19,48,44,0.05)";
const CONTOUR_MAJOR = "rgba(19,48,44,0.085)";
const POINT_FILL = "rgba(19,48,44,0.2)";
const TEAL = "rgb(20,70,64)";

/** Iso levels, sorted ascending. Every third one is an index contour. */
const LEVELS = new Float32Array([
  -0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6,
]);
const MAJOR_EVERY = 3;

interface FieldSpec {
  color: readonly [number, number, number];
  alpha: number;
  /** Radius, fraction of the larger viewport side. */
  radius: number;
  /** Home position and drift reach, fractions of the viewport. */
  ax: number;
  ay: number;
  rx: number;
  ry: number;
  /** Drift rates (radians per second) and phase. */
  wx: number;
  wy: number;
  phase: number;
}

const FIELDS: readonly FieldSpec[] = [
  // Amber, high on the right — the morning light of the hero.
  { color: [227, 154, 76], alpha: 0.13, radius: 0.46, ax: 0.82, ay: 0.16, rx: 0.1, ry: 0.08, wx: 0.021, wy: 0.017, phase: 0 },
  // Sea teal, low on the left.
  { color: [79, 143, 138], alpha: 0.09, radius: 0.52, ax: 0.1, ay: 0.7, rx: 0.08, ry: 0.12, wx: 0.016, wy: 0.023, phase: 2.1 },
  // Mist, a cool pool drifting through the middle.
  { color: [207, 221, 218], alpha: 0.55, radius: 0.42, ax: 0.48, ay: 0.52, rx: 0.2, ry: 0.14, wx: 0.012, wy: 0.019, phase: 4.2 },
  // Peach, upper left.
  { color: [242, 201, 160], alpha: 0.22, radius: 0.38, ax: 0.22, ay: 0.12, rx: 0.12, ry: 0.06, wx: 0.019, wy: 0.014, phase: 1.3 },
];

/* ================================================================== Scene */

function createAtmosphereScene(
  ctx: CanvasRenderingContext2D,
  env: CanvasEnvironment
): CanvasScene {
  const canvas = ctx.canvas;
  const seed = hashSeed("zypact/atmosphere");
  const noise = createNoise3D(mulberry32(seed));
  const random = mulberry32(seed ^ 0x2545f491);
  const coarse = env.coarsePointer;

  /* ------------------------------------------------------ Colour fields */
  const FIELD_SCALE = 1 / 8;
  const fieldCanvas = document.createElement("canvas");
  const fieldCtx = fieldCanvas.getContext("2d");
  const sprites = FIELDS.map((field) => {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 64;
    const g = sprite.getContext("2d");
    if (g) {
      const [r, gg, b] = field.color;
      // A Gaussian-like falloff, so the glows have no visible rim.
      const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, `rgba(${r},${gg},${b},1)`);
      gradient.addColorStop(0.3, `rgba(${r},${gg},${b},0.7)`);
      gradient.addColorStop(0.6, `rgba(${r},${gg},${b},0.26)`);
      gradient.addColorStop(0.82, `rgba(${r},${gg},${b},0.06)`);
      gradient.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, 64, 64);
    }
    return sprite;
  });

  /* ------------------------------------------------------------- Grid */
  let W = 0;
  let H = 0;
  let cell = 24;
  let cols = 0; // cells across
  let rows = 0; // cells down
  let field = new Float32Array(0);

  /* ----------------------------------------------------------- Points */
  // x, y (viewport px, before scroll parallax), drift speed, size, phase.
  const PT = 5;
  let count = 0;
  let points = new Float32Array(0);
  // Per-frame scratch: screen x, y, proximity to the focus.
  let screen = new Float32Array(0);

  /* ----------------------------------------------------------- Focus */
  let focusX = 0;
  let focusY = 0;
  let presence = 0;
  let shown = false;

  const seedPoints = () => {
    const target = Math.round((W * H) / (coarse ? 34000 : 26000));
    const next = clamp(target, coarse ? 10 : 16, coarse ? 22 : 56);
    if (next === count && points.length > 0) return;
    const fresh = new Float32Array(next * PT);
    for (let i = 0; i < next; i++) {
      const o = i * PT;
      if (i < count) {
        fresh.set(points.subarray(o, o + PT), o);
        continue;
      }
      fresh[o] = random() * W;
      fresh[o + 1] = random() * H;
      fresh[o + 2] = 5 + random() * 7;
      fresh[o + 3] = random() < 0.18 ? 1.9 : 1.2 + random() * 0.4;
      fresh[o + 4] = random() * TAU;
    }
    points = fresh;
    count = next;
    screen = new Float32Array(count * 3);
  };

  const computeField = (time: number, scrollY: number, reduced: boolean) => {
    const stride = cols + 1;
    // Features roughly 560 px across; the field slides up at 22 % of the
    // scroll speed and slowly morphs as the page moves.
    const scale = 1 / 560;
    const z = time * 0.035 + scrollY * 0.00011;
    const yShift = scrollY * 0.22;
    const lens = reduced ? 0 : presence * 0.42;
    const sigma2 = 1 / (175 * 175);

    for (let j = 0; j <= rows; j++) {
      const y = j * cell;
      for (let i = 0; i <= cols; i++) {
        const x = i * cell;
        let sx = x;
        let sy = y;
        if (lens > 0.001) {
          // Pull samples toward the pointer: the field swells like a lens
          // and the contours bend around it instead of growing new rings.
          const dx = x - focusX;
          const dy = y - focusY;
          const pull = lens * Math.exp(-(dx * dx + dy * dy) * sigma2);
          sx -= dx * pull;
          sy -= dy * pull;
        }
        const nx = sx * scale;
        const ny = (sy + yShift) * scale;
        const wx = noise(nx * 0.55 + 7.3, ny * 0.55, z * 0.6) * 0.6;
        const wy = noise(nx * 0.55 - 3.1, ny * 0.55 + 11.7, z * 0.6) * 0.6;
        const value =
          noise(nx + wx, ny + wy, z) * 0.78 +
          noise((nx + wx) * 2.3, (ny + wy) * 2.3, z * 1.4 + 5) * 0.22;
        field[j * stride + i] = value;
      }
    }
  };

  /* --------------------------------------------------------- Contours */
  // Marching squares, chained. Every crossing lies on a grid edge shared by
  // the two cells either side of it, so linking segments through edge ids
  // strings them into polylines, drawn as smooth curves through their
  // midpoints. Per-edge arrays are stamped per iso level rather than
  // cleared, and nothing is allocated per frame.
  let hEdges = 0; // horizontal edges come first in the edge id space
  let edgeX = new Float32Array(0);
  let edgeY = new Float32Array(0);
  let linkA = new Int32Array(0);
  let linkB = new Int32Array(0);
  let stamp = new Int32Array(0);
  let visit = new Int32Array(0);
  let touched = new Int32Array(0);
  let chainX = new Float32Array(0);
  let chainY = new Float32Array(0);
  let cellLo = new Float32Array(0);
  let cellHi = new Float32Array(0);
  let level = 0;
  let touchedCount = 0;

  const addPoint = (e: number, x: number, y: number) => {
    if (stamp[e] === level) return;
    stamp[e] = level;
    edgeX[e] = x;
    edgeY[e] = y;
    linkA[e] = -1;
    linkB[e] = -1;
    touched[touchedCount++] = e;
  };

  const join = (e1: number, x1: number, y1: number, e2: number, x2: number, y2: number) => {
    addPoint(e1, x1, y1);
    addPoint(e2, x2, y2);
    if (linkA[e1] === -1) linkA[e1] = e2;
    else linkB[e1] = e2;
    if (linkA[e2] === -1) linkA[e2] = e1;
    else linkB[e2] = e1;
  };

  const computeCellRanges = () => {
    const stride = cols + 1;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * stride + i;
        const a = field[k];
        const b = field[k + 1];
        const cc = field[k + stride + 1];
        const d = field[k + stride];
        const ci = j * cols + i;
        cellLo[ci] = Math.min(a, b, cc, d);
        cellHi[ci] = Math.max(a, b, cc, d);
      }
    }
  };

  /** Collects every segment of one iso level, linked through edge ids. */
  const collect = (iso: number) => {
    level++;
    if (level > 0x3fffffff) {
      stamp.fill(0);
      visit.fill(0);
      level = 1;
    }
    touchedCount = 0;
    const stride = cols + 1;
    for (let j = 0; j < rows; j++) {
      const y0 = j * cell;
      const y1 = y0 + cell;
      for (let i = 0; i < cols; i++) {
        const ci = j * cols + i;
        if (iso <= cellLo[ci] || iso > cellHi[ci]) continue;
        const k = j * stride + i;
        const a = field[k];
        const b = field[k + 1];
        const cc = field[k + stride + 1];
        const d = field[k + stride];
        const index =
          (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (cc > iso ? 2 : 0) | (d > iso ? 1 : 0);
        if (index === 0 || index === 15) continue;

        const x0 = i * cell;
        const x1 = x0 + cell;
        const eTop = j * cols + i;
        const eBottom = eTop + cols;
        const eLeft = hEdges + j * stride + i;
        const eRight = eLeft + 1;
        // Edge crossings, linearly interpolated. Neighbouring cells compute
        // a shared edge's crossing identically, so chains join exactly.
        const top = x0 + cell * ((iso - a) / (b - a));
        const right = y0 + cell * ((iso - b) / (cc - b));
        const bottom = x0 + cell * ((iso - d) / (cc - d));
        const left = y0 + cell * ((iso - a) / (d - a));

        switch (index) {
          case 1:
          case 14:
            join(eLeft, x0, left, eBottom, bottom, y1);
            break;
          case 2:
          case 13:
            join(eBottom, bottom, y1, eRight, x1, right);
            break;
          case 3:
          case 12:
            join(eLeft, x0, left, eRight, x1, right);
            break;
          case 4:
          case 11:
            join(eTop, top, y0, eRight, x1, right);
            break;
          case 6:
          case 9:
            join(eTop, top, y0, eBottom, bottom, y1);
            break;
          case 7:
          case 8:
            join(eLeft, x0, left, eTop, top, y0);
            break;
          case 5:
          case 10: {
            // Saddle: the centre value decides which corners connect.
            const centre = (a + b + cc + d) * 0.25 > iso;
            if ((index === 5) === centre) {
              join(eLeft, x0, left, eTop, top, y0);
              join(eBottom, bottom, y1, eRight, x1, right);
            } else {
              join(eTop, top, y0, eRight, x1, right);
              join(eLeft, x0, left, eBottom, bottom, y1);
            }
            break;
          }
        }
      }
    }
  };

  /** Adds one chain to the current path as a curve through midpoints. */
  const drawChain = (c: CanvasRenderingContext2D, n: number, closed: boolean) => {
    if (n < 2) return;
    if (closed) {
      c.moveTo((chainX[n - 1] + chainX[0]) * 0.5, (chainY[n - 1] + chainY[0]) * 0.5);
      for (let k = 0; k < n; k++) {
        const next = k + 1 < n ? k + 1 : 0;
        c.quadraticCurveTo(
          chainX[k],
          chainY[k],
          (chainX[k] + chainX[next]) * 0.5,
          (chainY[k] + chainY[next]) * 0.5
        );
      }
      return;
    }
    c.moveTo(chainX[0], chainY[0]);
    for (let k = 1; k < n - 1; k++) {
      c.quadraticCurveTo(
        chainX[k],
        chainY[k],
        (chainX[k] + chainX[k + 1]) * 0.5,
        (chainY[k] + chainY[k + 1]) * 0.5
      );
    }
    c.lineTo(chainX[n - 1], chainY[n - 1]);
  };

  const walk = (c: CanvasRenderingContext2D, start: number) => {
    let n = 0;
    let prev = -1;
    let current = start;
    while (current !== -1) {
      visit[current] = level;
      chainX[n] = edgeX[current];
      chainY[n] = edgeY[current];
      n++;
      const a = linkA[current];
      const b = linkB[current];
      let next = -1;
      if (a !== -1 && visit[a] !== level) next = a;
      else if (b !== -1 && visit[b] !== level) next = b;
      prev = current;
      current = next;
    }
    const closed = n > 2 && (linkA[prev] === start || linkB[prev] === start);
    drawChain(c, n, closed);
  };

  /** Traces the collected level: open chains from their ends, then loops. */
  const trace = (c: CanvasRenderingContext2D) => {
    for (let t = 0; t < touchedCount; t++) {
      const e = touched[t];
      if (visit[e] !== level && linkB[e] === -1) walk(c, e);
    }
    for (let t = 0; t < touchedCount; t++) {
      const e = touched[t];
      if (visit[e] !== level) walk(c, e);
    }
  };

  /** Adds every contour of one group (index or ordinary) to the path. */
  const contours = (c: CanvasRenderingContext2D, major: boolean) => {
    for (let l = 0; l < LEVELS.length; l++) {
      if ((l % MAJOR_EVERY === 1) !== major) continue;
      collect(LEVELS[l]);
      trace(c);
    }
  };

  const reveal = (reduced: boolean) => {
    if (shown) return;
    shown = true;
    if (reduced || typeof canvas.animate !== "function") return;
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 2200,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
  };

  return {
    resize(size: CanvasSize) {
      W = size.width;
      H = size.height;
      const target = coarse ? 1000 : 2600;
      cell = clamp(Math.round(Math.sqrt((W * H) / target)), 18, 44);
      cols = Math.ceil(W / cell);
      rows = Math.ceil(H / cell);
      const vertices = (cols + 1) * (rows + 1);
      if (field.length < vertices) field = new Float32Array(vertices);
      const cells = cols * rows;
      if (cellLo.length < cells) {
        cellLo = new Float32Array(cells);
        cellHi = new Float32Array(cells);
      }
      hEdges = (rows + 1) * cols;
      const edges = hEdges + rows * (cols + 1);
      if (edgeX.length < edges) {
        edgeX = new Float32Array(edges);
        edgeY = new Float32Array(edges);
        linkA = new Int32Array(edges);
        linkB = new Int32Array(edges);
        stamp = new Int32Array(edges);
        visit = new Int32Array(edges);
        touched = new Int32Array(edges);
        chainX = new Float32Array(edges + 1);
        chainY = new Float32Array(edges + 1);
      }
      fieldCanvas.width = Math.max(2, Math.ceil(W * FIELD_SCALE));
      fieldCanvas.height = Math.max(2, Math.ceil(H * FIELD_SCALE));
      seedPoints();
    },

    render(frame: CanvasFrame) {
      const { ctx: c, dpr, time: t, delta: dt, pointer, scroll } = frame;
      const reduced = frame.reducedMotion;
      if (W <= 0 || H <= 0) return;

      /* ---------------------------------------------------- Focus */
      const wanderX = W * (0.5 + 0.36 * Math.sin(t * 0.061 + 0.4));
      const wanderY = H * (0.46 + 0.3 * Math.sin(t * 0.047 + 2.2));
      const usePointer = pointer.active && !coarse && !reduced;
      const goalX = usePointer ? pointer.px : wanderX;
      const goalY = usePointer ? pointer.py : wanderY;
      const follow = frame.first ? 1 : 1 - Math.exp(-dt * (usePointer ? 6 : 1.5));
      focusX += (goalX - focusX) * follow;
      focusY += (goalY - focusY) * follow;
      const presenceGoal = usePointer ? 1 : 0;
      presence += (presenceGoal - presence) * (frame.first ? 1 : 1 - Math.exp(-dt * 2.2));

      const scrollY = reduced ? 0 : scroll.y;

      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.globalCompositeOperation = "source-over";
      c.globalAlpha = 1;
      c.clearRect(0, 0, W, H);

      /* --------------------------------------------- Colour fields */
      if (fieldCtx) {
        const fw = fieldCanvas.width;
        const fh = fieldCanvas.height;
        fieldCtx.setTransform(1, 0, 0, 1, 0, 0);
        fieldCtx.clearRect(0, 0, fw, fh);
        const big = Math.max(fw, fh);
        const scrollPhase = scrollY * 0.00035;
        for (let i = 0; i < FIELDS.length; i++) {
          const f = FIELDS[i];
          const x = fw * (f.ax + f.rx * Math.sin(t * f.wx + f.phase + scrollPhase));
          const y = fh * (f.ay + f.ry * Math.cos(t * f.wy + f.phase * 1.3 - scrollPhase));
          const r = f.radius * big * (1 + 0.06 * Math.sin(t * 0.05 + f.phase));
          fieldCtx.globalAlpha = f.alpha;
          fieldCtx.drawImage(sprites[i], x - r, y - r, r * 2, r * 2);
        }
        fieldCtx.globalAlpha = 1;
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = "high";
        c.drawImage(fieldCanvas, 0, 0, W, H);
      }

      /* ------------------------------------------------- Contours */
      computeField(t, scrollY, reduced);
      computeCellRanges();
      c.lineJoin = "round";
      c.lineCap = "round";

      c.beginPath();
      contours(c, false);
      c.strokeStyle = CONTOUR_MINOR;
      c.lineWidth = 0.85;
      c.stroke();

      c.beginPath();
      contours(c, true);
      c.strokeStyle = CONTOUR_MAJOR;
      c.lineWidth = 1.1;
      c.stroke();

      /* ---------------------------------------------------- Points */
      const pad = 24;
      const spanX = W + pad * 2;
      const spanY = H + pad * 2;
      const parallax = scrollY * 0.08;
      const reach = Math.min(260, Math.max(160, Math.min(W, H) * 0.32));
      const strength = Math.max(presence, coarse || reduced ? 0.55 : 0.4);
      for (let i = 0; i < count; i++) {
        const o = i * PT;
        if (!reduced && dt > 0) {
          // Drift along a slowly turning flow field, rising gently.
          const angle =
            noise(points[o] * 0.0011, points[o + 1] * 0.0011, t * 0.03 + 40) * TAU;
          const speed = points[o + 2];
          points[o] += Math.cos(angle) * speed * dt;
          points[o + 1] += (Math.sin(angle) * speed - 2.5) * dt;
          if (points[o] < -pad) points[o] += spanX;
          else if (points[o] > W + pad) points[o] -= spanX;
          if (points[o + 1] < -pad) points[o + 1] += spanY;
          else if (points[o + 1] > H + pad) points[o + 1] -= spanY;
        }
        let y = (points[o + 1] + pad - parallax) % spanY;
        if (y < 0) y += spanY;
        const sx = points[o];
        const sy = y - pad;
        const dx = sx - focusX;
        const dy = sy - focusY;
        const proximity = clamp(1 - Math.sqrt(dx * dx + dy * dy) / reach, 0, 1);
        const s = i * 3;
        screen[s] = sx;
        screen[s + 1] = sy;
        screen[s + 2] = proximity * proximity * (3 - 2 * proximity);
      }

      // Hairlines between points that are both near the focus.
      c.strokeStyle = TEAL;
      c.lineWidth = 0.75;
      const link = reach * 0.95;
      for (let i = 0; i < count; i++) {
        const pi = screen[i * 3 + 2];
        if (pi <= 0) continue;
        for (let j = i + 1; j < count; j++) {
          const pj = screen[j * 3 + 2];
          if (pj <= 0) continue;
          const dx = screen[i * 3] - screen[j * 3];
          const dy = screen[i * 3 + 1] - screen[j * 3 + 1];
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= link) continue;
          c.globalAlpha = 0.3 * (1 - dist / link) * Math.min(pi, pj) * strength;
          c.beginPath();
          c.moveTo(screen[i * 3], screen[i * 3 + 1]);
          c.lineTo(screen[j * 3], screen[j * 3 + 1]);
          c.stroke();
        }
      }

      // The points: faint everywhere, brighter with a ring near the focus.
      c.globalAlpha = 1;
      c.fillStyle = POINT_FILL;
      c.beginPath();
      for (let i = 0; i < count; i++) {
        const x = screen[i * 3];
        const y = screen[i * 3 + 1];
        const r = points[i * PT + 3];
        c.moveTo(x + r, y);
        c.arc(x, y, r, 0, TAU);
      }
      c.fill();

      c.fillStyle = TEAL;
      c.strokeStyle = TEAL;
      c.lineWidth = 0.8;
      for (let i = 0; i < count; i++) {
        const p = screen[i * 3 + 2] * strength;
        if (p <= 0.02) continue;
        const x = screen[i * 3];
        const y = screen[i * 3 + 1];
        const r = points[i * PT + 3];
        const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.4 + points[i * PT + 4]);
        c.globalAlpha = 0.5 * p;
        c.beginPath();
        c.arc(x, y, r + 0.4, 0, TAU);
        c.fill();
        c.globalAlpha = 0.28 * p * (0.6 + 0.4 * pulse);
        c.beginPath();
        c.arc(x, y, r + 3.5 + pulse * 1.5, 0, TAU);
        c.stroke();
      }
      c.globalAlpha = 1;

      reveal(reduced);
    },

    dispose() {
      fieldCanvas.width = fieldCanvas.height = 0;
      for (const sprite of sprites) sprite.width = sprite.height = 0;
    },
  };
}
