"use client";

import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";

import {
  clamp,
  createNoise2D,
  createNoise3D,
  fbm2,
  fbm3,
  hashSeed,
  lerp,
  mulberry32,
  ridged2,
  smoothstep,
  type Noise2D,
  type Noise3D,
  type Random,
} from "./noise";
import {
  useCanvasLoop,
  type CanvasEnvironment,
  type CanvasFrame,
  type CanvasScene,
  type CanvasSize,
} from "./use-canvas-loop";

/**
 * A procedural mountain landscape: layered ranges with atmospheric
 * perspective, sunlit and shadowed faces, rim light, drifting valley fog, a
 * breathing sun and a few light motes, with pointer and scroll parallax.
 *
 * Everything static is painted once per size into offscreen canvases — the
 * sky, one canvas per range (silhouette, per-pixel face shading, rim light)
 * and a tileable texture per fog band — so a frame is a handful of drawImage
 * calls plus a few small sprites. Every shape comes from a seeded PRNG and
 * seeded noise, so a variant looks the same on every load, after a resize
 * and on a StrictMode re-mount. Shapes are laid out in units of the canvas
 * height around a per-variant anchor, so a resize reveals more or less of the
 * same landscape instead of stretching it.
 *
 * The canvas fills its positioned parent (absolute inset-0) unless
 * `className` overrides that. Edges named in the variant's `fade` blend to
 * transparent, so the page behind shows through: dawn fades on its left and
 * top, night on its left.
 */

export type RidgeVariant = "dawn" | "dusk" | "night";

export interface RidgeCanvasProps {
  variant: RidgeVariant;
  /** Sizing and positioning; the default fills the positioned parent. */
  className?: string;
  /** Pointer parallax (fine pointers only). Scroll parallax always runs. */
  interactive?: boolean;
}

export function RidgeCanvas({
  variant,
  className,
  interactive = true,
}: RidgeCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const createScene = useCallback(
    (ctx: CanvasRenderingContext2D, env: CanvasEnvironment) =>
      createRidgeScene(ctx, SCENES[variant], env, interactive),
    [variant, interactive]
  );
  useCanvasLoop(ref, createScene, {
    maxDpr: 2,
    maxPixels: 3_200_000,
    fps: 60,
    staticTime: 9,
  });

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 block h-full w-full",
        className
      )}
    />
  );
}

/* ================================================================== Specs */

type RGB = readonly [number, number, number];

/*
 * Brand palette, for reference: cream #F6F1E8, ink #13302C, deep teal
 * #144640 / #0F3632, sea teal #4F8F8A, mist #CFDDDA, amber #E39A4C,
 * peach #F2C9A0. Scene colours are mixed from these.
 */

interface FogSpec {
  /** Band centre, as a fraction of the canvas height. */
  v: number;
  /** Half the band's thickness, as a fraction of the canvas height. */
  height: number;
  color: RGB;
  alpha: number;
  /** Drift, CSS px per second. Negative drifts left. */
  speed: number;
  /** Wisp size, CSS px. */
  scale: number;
}

interface SummitSpec {
  /** Summit position: fraction of the width, fraction of the height. */
  u: number;
  v: number;
  /** Flank reach to the left and right, in canvas heights. */
  left: number;
  right: number;
}

interface LayerSpec {
  /** Foot of the range, as a fraction of the height from the top. */
  base: number;
  /** Tallest generated peak, as a fraction of the height. */
  amp: number;
  /** Flank steepness range (rise over run). */
  steep: readonly [number, number];
  /** Flank curve: 1 straight, above 1 concave (alpine), below 1 rounded. */
  shape: number;
  /** Crest roughness, as a fraction of `amp`. */
  rough: number;
  /** Colour at the crest, and the valley haze it fades to below. */
  color: RGB;
  foot: RGB;
  /** Depth below the crest at which `foot` is reached, fraction of height. */
  footDepth: number;
  /** Lit/shadowed face strength, and how far down the faces it reaches. */
  wash: number;
  washDepth: number;
  /** Soft tonal variation across the faces. */
  mottle: number;
  /** Rim light strength. */
  rim: number;
  /** Parallax depth: 0 far, 1 near. */
  depth: number;
  /** A placed summit, for composition. */
  summit?: SummitSpec;
  /** A fog band drawn in front of this layer, filling its valleys. */
  fog?: FogSpec;
}

interface SceneSpec {
  seed: string;
  /** Fraction of the width the landscape stays anchored to on resize. */
  anchor: number;
  /** Relief multiplier across the width (u in 0..1). */
  envelope: (u: number) => number;
  sky: ReadonlyArray<readonly [number, RGB]>;
  sun: {
    u: number;
    v: number;
    /** Halo colour and inner core colour. */
    glow: RGB;
    core: RGB;
    /** Halo radius, fraction of the larger canvas side. */
    radius: number;
    alpha: number;
    /** Visible disc radius, fraction of the height (0: no disc). */
    disc: number;
    discColor: RGB;
    /** How far the sun warms crests, fraction of the larger side. */
    reach: number;
    /** Where the light comes from, as a multiple of the sun's offset from
     *  the canvas centre: large values make it a distant, directional
     *  light; small ones a nearby glow that lights each crest from its own
     *  side. */
    distance: number;
  };
  /** Lit face colour away from the sun, and close to it. */
  light: RGB;
  warm: RGB;
  /** Colour of faces turned away from the sun. */
  shade: RGB;
  /** 0: rims follow faces turned to the sun; 1: crests glow wherever they
   *  are near the sun (a backlit sky). */
  backlight: number;
  /** How fast a sunlit face narrows toward its sunward flank as it falls
   *  (px of terminator drift per px of depth). */
  slant: number;
  /** Soft glow bleeding past backlit crests into the sky. */
  halo: number;
  /** Screen-blended light scattered over everything near the sun. */
  bloom: { color: RGB; alpha: number; radius: number };
  layers: readonly LayerSpec[];
  /** Fraction of the width/height over which each edge fades out. */
  fade: { left: number; top: number; right: number; bottom: number };
  motes: {
    count: number;
    color: RGB;
    alpha: number;
    /** Sprite radius, CSS px. */
    size: number;
    /** Vertical band they drift in, fractions of the height. */
    top: number;
    bottom: number;
    blend: GlobalCompositeOperation;
  };
  stars: number;
  /** Parallax reach in CSS px: pointer x/y, scroll, idle sway. */
  parallax: { x: number; y: number; scroll: number; idle: number };
}

const SCENES: Record<RidgeVariant, SceneSpec> = {
  /*
   * Hero, behind the dashboard. A warm cream sky with an amber sun beyond the
   * top-right corner; blue-grey ranges recede into cream haze; a broad massif
   * rises on the right and its sun-facing flank burns amber. Fades to
   * transparent on the left and top so it melts into the cream page.
   */
  dawn: {
    seed: "zypact/dawn",
    anchor: 0.82,
    envelope: (u) => 0.28 + 0.72 * smoothstep(-0.1, 0.85, u),
    sky: [
      [0, [248, 241, 230]],
      [0.3, [247, 235, 218]],
      [0.6, [244, 226, 205]],
      [1, [240, 226, 210]],
    ],
    sun: {
      u: 0.97,
      v: 0.04,
      glow: [240, 178, 112],
      core: [252, 224, 186],
      radius: 0.66,
      alpha: 0.9,
      disc: 0,
      discColor: [255, 240, 214],
      reach: 0.62,
      distance: 5,
    },
    light: [248, 216, 184],
    warm: [233, 146, 84],
    shade: [24, 58, 62],
    backlight: 0.1,
    slant: 0.3,
    halo: 0.2,
    bloom: { color: [255, 204, 150], alpha: 0.13, radius: 0.5 },
    layers: [
      {
        base: 0.5,
        amp: 0.13,
        steep: [0.55, 1.05],
        shape: 1.1,
        rough: 0.2,
        color: [196, 206, 203],
        foot: [240, 230, 215],
        footDepth: 0.16,
        wash: 0.2,
        washDepth: 0.05,
        mottle: 0,
        rim: 0.25,
        depth: 0.1,
        fog: { v: 0.55, height: 0.075, color: [248, 237, 222], alpha: 0.85, speed: 5, scale: 150 },
      },
      {
        base: 0.57,
        amp: 0.18,
        steep: [0.5, 1],
        shape: 1.15,
        rough: 0.18,
        color: [158, 181, 182],
        foot: [232, 224, 211],
        footDepth: 0.17,
        wash: 0.28,
        washDepth: 0.06,
        mottle: 0.03,
        rim: 0.32,
        depth: 0.22,
        fog: { v: 0.625, height: 0.08, color: [246, 234, 218], alpha: 0.75, speed: -7, scale: 170 },
      },
      {
        base: 0.65,
        amp: 0.22,
        steep: [0.5, 0.95],
        shape: 1.2,
        rough: 0.16,
        color: [112, 146, 149],
        foot: [204, 205, 197],
        footDepth: 0.18,
        wash: 0.45,
        washDepth: 0.09,
        mottle: 0.04,
        rim: 0.42,
        depth: 0.36,
        fog: { v: 0.71, height: 0.085, color: [244, 231, 214], alpha: 0.6, speed: 9, scale: 190 },
      },
      {
        base: 0.76,
        amp: 0.2,
        steep: [0.5, 0.9],
        shape: 1.25,
        rough: 0.14,
        color: [66, 106, 110],
        foot: [146, 160, 158],
        footDepth: 0.22,
        wash: 1,
        washDepth: 0.17,
        mottle: 0.05,
        rim: 0.7,
        depth: 0.56,
        summit: { u: 0.85, v: 0.07, left: 0.78, right: 1.3 },
        fog: { v: 0.82, height: 0.075, color: [238, 226, 210], alpha: 0.45, speed: -12, scale: 210 },
      },
      {
        base: 0.87,
        amp: 0.16,
        steep: [0.45, 0.85],
        shape: 1.2,
        rough: 0.14,
        color: [38, 80, 79],
        foot: [80, 108, 107],
        footDepth: 0.2,
        wash: 0.32,
        washDepth: 0.07,
        mottle: 0.05,
        rim: 0.5,
        depth: 0.78,
      },
      {
        base: 0.98,
        amp: 0.12,
        steep: [0.4, 0.8],
        shape: 1.2,
        rough: 0.12,
        color: [22, 61, 57],
        foot: [26, 66, 62],
        footDepth: 0.2,
        wash: 0.22,
        washDepth: 0.05,
        mottle: 0.05,
        rim: 0.35,
        depth: 1,
      },
    ],
    fade: { left: 0.44, top: 0.3, right: 0, bottom: 0.04 },
    motes: {
      count: 16,
      color: [255, 238, 210],
      alpha: 0.5,
      size: 6,
      top: 0.2,
      bottom: 0.96,
      blend: "screen",
    },
    stars: 0,
    parallax: { x: 16, y: 9, scroll: 44, idle: 3 },
  },

  /*
   * The leaf in "Why teams use Zypact": sunset. Deep teal-blue sky warming
   * to an orange horizon, a low sun behind the far ranges, ridges stepping
   * forward into dark teal, warm mist pooled in the valleys.
   */
  dusk: {
    seed: "zypact/dusk",
    anchor: 0.5,
    envelope: () => 1,
    sky: [
      [0, [38, 74, 82]],
      [0.2, [66, 102, 110]],
      [0.36, [130, 146, 144]],
      [0.47, [214, 172, 132]],
      [0.55, [238, 180, 118]],
      [0.68, [243, 196, 148]],
      [1, [244, 206, 166]],
    ],
    sun: {
      u: 0.66,
      v: 0.535,
      glow: [240, 160, 86],
      core: [253, 222, 176],
      radius: 0.55,
      alpha: 0.85,
      disc: 0.042,
      discColor: [255, 238, 208],
      reach: 0.4,
      distance: 0.6,
    },
    light: [236, 190, 140],
    warm: [244, 160, 84],
    shade: [18, 42, 48],
    backlight: 0.55,
    slant: 0.45,
    halo: 0.6,
    bloom: { color: [255, 196, 138], alpha: 0.38, radius: 0.5 },
    layers: [
      {
        base: 0.555,
        amp: 0.085,
        steep: [0.55, 1.1],
        shape: 1.1,
        rough: 0.22,
        color: [178, 160, 150],
        foot: [236, 188, 142],
        footDepth: 0.09,
        wash: 0.12,
        washDepth: 0.04,
        mottle: 0,
        rim: 0.55,
        depth: 0.1,
        fog: { v: 0.585, height: 0.045, color: [249, 204, 154], alpha: 0.8, speed: 4, scale: 120 },
      },
      {
        base: 0.62,
        amp: 0.13,
        steep: [0.5, 1.05],
        shape: 1.15,
        rough: 0.2,
        color: [134, 136, 141],
        foot: [216, 180, 150],
        footDepth: 0.11,
        wash: 0.18,
        washDepth: 0.05,
        mottle: 0,
        rim: 0.5,
        depth: 0.22,
        fog: { v: 0.66, height: 0.055, color: [242, 198, 158], alpha: 0.65, speed: -6, scale: 140 },
      },
      {
        base: 0.7,
        amp: 0.19,
        steep: [0.5, 1],
        shape: 1.2,
        rough: 0.18,
        color: [94, 110, 119],
        foot: [172, 160, 150],
        footDepth: 0.14,
        wash: 0.24,
        washDepth: 0.07,
        mottle: 0.05,
        rim: 0.45,
        depth: 0.38,
        fog: { v: 0.75, height: 0.065, color: [220, 198, 180], alpha: 0.5, speed: 8, scale: 160 },
      },
      {
        base: 0.8,
        amp: 0.22,
        steep: [0.5, 0.95],
        shape: 1.25,
        rough: 0.16,
        color: [58, 82, 92],
        foot: [122, 128, 129],
        footDepth: 0.16,
        wash: 0.26,
        washDepth: 0.06,
        mottle: 0.07,
        rim: 0.4,
        depth: 0.56,
        fog: { v: 0.85, height: 0.065, color: [184, 188, 188], alpha: 0.42, speed: -10, scale: 180 },
      },
      {
        base: 0.9,
        amp: 0.2,
        steep: [0.45, 0.9],
        shape: 1.2,
        rough: 0.14,
        color: [33, 57, 64],
        foot: [70, 89, 94],
        footDepth: 0.16,
        wash: 0.26,
        washDepth: 0.06,
        mottle: 0.08,
        rim: 0.35,
        depth: 0.78,
        summit: { u: 0.16, v: 0.6, left: 0.7, right: 0.85 },
      },
      {
        base: 0.99,
        amp: 0.13,
        steep: [0.4, 0.8],
        shape: 1.2,
        rough: 0.12,
        color: [18, 40, 44],
        foot: [22, 46, 50],
        footDepth: 0.2,
        wash: 0.16,
        washDepth: 0.05,
        mottle: 0.08,
        rim: 0.25,
        depth: 1,
      },
    ],
    fade: { left: 0, top: 0, right: 0, bottom: 0 },
    motes: {
      count: 12,
      color: [255, 216, 172],
      alpha: 0.5,
      size: 5,
      top: 0.34,
      bottom: 0.96,
      blend: "screen",
    },
    stars: 0,
    parallax: { x: 12, y: 7, scroll: 34, idle: 2.5 },
  },

  /*
   * The dark CTA band. A night sky in the band's own deep teal (#0F3632)
   * with faint stars, a soft glow low on the horizon at the right, and dark
   * ranges touched by a thin sea-green rim near that glow. Fades into the
   * band on the left, where the copy sits.
   */
  night: {
    seed: "zypact/night",
    anchor: 0.76,
    envelope: (u) => 0.14 + 0.86 * smoothstep(0.22, 0.8, u),
    sky: [
      [0, [13, 48, 45]],
      [0.5, [15, 54, 50]],
      [1, [19, 63, 58]],
    ],
    sun: {
      u: 0.8,
      v: 0.8,
      glow: [58, 126, 117],
      core: [150, 158, 120],
      radius: 0.42,
      alpha: 0.5,
      disc: 0,
      discColor: [255, 240, 214],
      reach: 0.36,
      distance: 1,
    },
    light: [110, 176, 166],
    warm: [190, 182, 136],
    shade: [6, 26, 24],
    backlight: 0.7,
    slant: 0.45,
    halo: 0.3,
    bloom: { color: [86, 156, 146], alpha: 0.14, radius: 0.42 },
    layers: [
      {
        base: 0.62,
        amp: 0.2,
        steep: [0.55, 1.05],
        shape: 1.15,
        rough: 0.2,
        color: [27, 74, 69],
        foot: [24, 68, 63],
        footDepth: 0.3,
        wash: 0.14,
        washDepth: 0.06,
        mottle: 0,
        rim: 0.38,
        depth: 0.12,
        fog: { v: 0.7, height: 0.1, color: [46, 104, 97], alpha: 0.42, speed: 5, scale: 150 },
      },
      {
        base: 0.72,
        amp: 0.27,
        steep: [0.5, 1],
        shape: 1.2,
        rough: 0.18,
        color: [20, 61, 57],
        foot: [22, 64, 60],
        footDepth: 0.3,
        wash: 0.14,
        washDepth: 0.06,
        mottle: 0,
        rim: 0.34,
        depth: 0.3,
        summit: { u: 0.7, v: 0.2, left: 0.75, right: 0.95 },
        fog: { v: 0.81, height: 0.1, color: [36, 88, 82], alpha: 0.38, speed: -7, scale: 170 },
      },
      {
        base: 0.83,
        amp: 0.24,
        steep: [0.45, 0.95],
        shape: 1.2,
        rough: 0.16,
        color: [14, 48, 45],
        foot: [16, 54, 50],
        footDepth: 0.3,
        wash: 0.12,
        washDepth: 0.06,
        mottle: 0.04,
        rim: 0.3,
        depth: 0.55,
      },
      {
        base: 0.93,
        amp: 0.18,
        steep: [0.4, 0.85],
        shape: 1.2,
        rough: 0.14,
        color: [10, 38, 36],
        foot: [11, 41, 39],
        footDepth: 0.3,
        wash: 0.1,
        washDepth: 0.05,
        mottle: 0.05,
        rim: 0.24,
        depth: 0.8,
      },
      {
        base: 1.01,
        amp: 0.12,
        steep: [0.35, 0.75],
        shape: 1.2,
        rough: 0.12,
        color: [8, 31, 29],
        foot: [8, 31, 29],
        footDepth: 0.3,
        wash: 0.08,
        washDepth: 0.05,
        mottle: 0.05,
        rim: 0.18,
        depth: 1,
      },
    ],
    fade: { left: 0.52, top: 0, right: 0, bottom: 0 },
    motes: {
      count: 10,
      color: [160, 226, 206],
      alpha: 0.45,
      size: 4.5,
      top: 0.35,
      bottom: 0.98,
      blend: "lighter",
    },
    stars: 120,
    parallax: { x: 18, y: 6, scroll: 22, idle: 3 },
  },
};

/* ================================================================ Helpers */

const TAU = Math.PI * 2;
/** Crest sample spacing, CSS px. */
const STEP = 2;
/** Peaks are generated across this many canvas heights either side of the
 *  anchor, enough for any aspect ratio up to about 6:1. */
const PEAK_RANGE = 7;
/** A resize settles for this long before layers are repainted at the new
 *  size; until then the previous paint is stretched to fit. */
const REBUILD_DELAY_MS = 160;
/** Main-thread time a frame may spend painting layers. The paint is spread
 *  over frames so it never becomes one long task. */
const BUILD_BUDGET_MS = 8;

function rgba(c: RGB, a = 1): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return ctx;
}

function release(canvas: HTMLCanvasElement | null | undefined) {
  if (!canvas) return;
  // Zeroing the size frees the bitmap now instead of at garbage collection.
  canvas.width = 0;
  canvas.height = 0;
}

/** In-place box blur of a 1D array (build time only). */
function blur1d(values: Float32Array, radius: number, passes: number) {
  const n = values.length;
  const tmp = new Float32Array(n);
  for (let pass = 0; pass < passes; pass++) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k <= Math.min(radius, n - 1); k++) {
      sum += values[k];
      count++;
    }
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / count;
      const drop = i - radius;
      const add = i + radius + 1;
      if (drop >= 0) {
        sum -= values[drop];
        count--;
      }
      if (add < n) {
        sum += values[add];
        count++;
      }
    }
    values.set(tmp);
  }
}

/** Smooth maximum: rounds the notch where two flanks meet into a saddle. */
function smax(a: number, b: number, k: number): number {
  const d = a - b;
  return 0.5 * (a + b + Math.sqrt(d * d + k * k));
}

/** Soft round sprite: `color` at the centre fading to transparent. */
function makeGlowSprite(color: RGB, size: number, hardness: number) {
  const canvas = makeCanvas(size, size);
  const g = context2d(canvas);
  const r = size / 2;
  const gradient = g.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, rgba(color, 1));
  gradient.addColorStop(hardness, rgba(color, 0.5));
  gradient.addColorStop(1, rgba(color, 0));
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return canvas;
}

/* ================================================================== Peaks */

/**
 * Seeded peaks for one range, in canvas-height units around the anchor:
 * [x, height, left reach, right reach] per peak. Size-independent, so the
 * same range comes back after every resize.
 */
function generatePeaks(layer: LayerSpec, random: Random): Float32Array {
  const out: number[] = [];
  let x = -PEAK_RANGE - random() * layer.amp;
  while (x < PEAK_RANGE) {
    const h = layer.amp * (0.36 + 0.64 * Math.pow(random(), 0.8));
    const left = h / lerp(layer.steep[0], layer.steep[1], random());
    const right = h / lerp(layer.steep[0], layer.steep[1], random());
    out.push(x, h, left, right);
    // Step by about one flank's reach, so neighbouring flanks always
    // overlap into saddles instead of leaving flat ground between peaks.
    x += (left + right) * 0.5 * (0.6 + 0.8 * random());
  }
  return Float32Array.from(out);
}

/** Height of a range's crest above its foot at x (CSS px), in canvas
 *  heights. */
function crestRise(
  spec: SceneSpec,
  layer: LayerSpec,
  peaks: Float32Array,
  lane: number,
  x: number,
  W: number,
  H: number,
  noise: Noise2D
): number {
  const X = (x - spec.anchor * W) / H;
  const soft = layer.amp * 0.18;
  let rise = 0;
  for (let p = 0; p < peaks.length; p += 4) {
    const d = X - peaks[p];
    const reach = d < 0 ? peaks[p + 2] : peaks[p + 3];
    const t = 1 - Math.abs(d) / reach;
    if (t <= 0) continue;
    // The rounding fades in from the foot, so a flank joins the profile
    // continuously rather than with a step.
    rise = smax(rise, peaks[p + 1] * Math.pow(t, layer.shape), soft * smoothstep(0, 0.3, t));
  }
  rise *= spec.envelope(x / W);

  const summit = layer.summit;
  if (summit) {
    const d = X - ((summit.u - spec.anchor) * W) / H;
    const reach = d < 0 ? summit.left : summit.right;
    const t = 1 - Math.abs(d) / reach;
    if (t > 0) {
      rise = smax(
        rise,
        (layer.base - summit.v) * Math.pow(t, layer.shape),
        soft * smoothstep(0, 0.3, t)
      );
    }
  }

  // A slow swell so the foot of the range is never a ruled line, and
  // fractal roughness, stronger high on the slopes than at the foot.
  const swell = (fbm2(noise, X * 1.2, lane + 77, 2) * 0.5 + 0.5) * layer.amp * 0.24;
  const detail =
    fbm2(noise, X * 7.3, lane, 4) * 0.7 +
    (ridged2(noise, X * 17, lane + 40, 3, 2.1, 0.5, 1.4) - 0.55) * 0.5;
  const height = clamp(rise / Math.max(layer.amp, 0.01), 0, 1.5);
  return rise + swell + layer.amp * layer.rough * detail * (0.3 + 0.7 * height);
}

/* ================================================================ Builder */

interface BuiltFog {
  canvas: HTMLCanvasElement;
  y0: number;
  h: number;
  period: number;
  alpha: number;
  speed: number;
}

interface BuiltLayer {
  canvas: HTMLCanvasElement;
  y0: number;
  w: number;
  h: number;
  depth: number;
  fog: BuiltFog | null;
}

interface Built {
  W: number;
  H: number;
  mx: number;
  my: number;
  sky: HTMLCanvasElement;
  layers: BuiltLayer[];
  mask: HTMLCanvasElement | null;
  sunX: number;
  sunY: number;
  sunR: number;
  bloomR: number;
}

/** How much each crest point turns toward the light relative to flat
 *  ground (+ lit, - shadowed), from a crest smoothed by `radius` samples. */
function lightAlong(
  ys: Float32Array,
  radius: number,
  mx: number,
  lightX: number,
  lightY: number
): Float32Array {
  const n = ys.length;
  const smooth = new Float32Array(ys);
  if (radius > 0) blur1d(smooth, radius, 2);
  const lit = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const ka = Math.max(0, k - 2);
    const kb = Math.min(n - 1, k + 2);
    const tx = (kb - ka) * STEP;
    const ty = smooth[kb] - smooth[ka];
    const tl = Math.hypot(tx, ty) || 1;
    // Outward normal of the crest (pointing up, out of the mountain).
    const nx = ty / tl;
    const ny = -tx / tl;
    const lx0 = lightX - (-mx + k * STEP);
    const ly0 = lightY - smooth[k];
    const ll = Math.hypot(lx0, ly0) || 1;
    const lx = lx0 / ll;
    const ly = ly0 / ll;
    // n·l minus the same for flat ground ((0,-1)·l = -ly).
    lit[k] = clamp((nx * lx + ny * ly + ly) * 1.8, -1, 1);
  }
  return lit;
}

/**
 * Paints a scene at one size. A generator, so the work can be spread over
 * frames: it yields after the sky and after each range. Abandoning it
 * (`return()`) releases whatever it had painted so far.
 */
function* buildScene(
  spec: SceneSpec,
  peaks: readonly Float32Array[],
  noise: Noise2D,
  noise3: Noise3D,
  W: number,
  H: number,
  dpr: number
): Generator<void, Built | null, void> {
  const P = spec.parallax;
  const mx = Math.ceil(P.x + P.idle + 8);
  const my = Math.ceil(P.y + P.scroll * 0.5 + 8);
  const fullW = W + mx * 2;
  const sunX = spec.sun.u * W;
  const sunY = spec.sun.v * H;
  const big = Math.max(W, H);
  const owned: HTMLCanvasElement[] = [];
  const n = Math.ceil(fullW / STEP) + 2;
  let scratch: HTMLCanvasElement | null = null;
  const strip = makeCanvas(n, 1);
  let complete = false;

  try {
  /* ------------------------------------------------------------- Sky */
  // Smooth content: half resolution is indistinguishable once upscaled.
  const skyScale = Math.min(dpr, 0.5);
  const sky = makeCanvas(fullW * skyScale, (H + my * 2) * skyScale);
  owned.push(sky);
  {
    const g = context2d(sky);
    g.setTransform(skyScale, 0, 0, skyScale, mx * skyScale, my * skyScale);
    const gradient = g.createLinearGradient(0, -my, 0, H + my);
    for (const [stop, color] of spec.sky) {
      gradient.addColorStop((stop * H + my) / (H + my * 2), rgba(color));
    }
    g.fillStyle = gradient;
    g.fillRect(-mx, -my, fullW, H + my * 2);

    const R = spec.sun.radius * big;
    const halo = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, R);
    halo.addColorStop(0, rgba(spec.sun.core, spec.sun.alpha));
    halo.addColorStop(0.16, rgba(spec.sun.glow, spec.sun.alpha * 0.72));
    halo.addColorStop(0.45, rgba(spec.sun.glow, spec.sun.alpha * 0.24));
    halo.addColorStop(1, rgba(spec.sun.glow, 0));
    g.fillStyle = halo;
    g.fillRect(-mx, -my, fullW, H + my * 2);

    if (spec.sun.disc > 0) {
      const r = spec.sun.disc * H;
      const disc = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, r * 1.8);
      disc.addColorStop(0, rgba(spec.sun.discColor, 1));
      disc.addColorStop(0.5, rgba(spec.sun.discColor, 0.95));
      disc.addColorStop(0.62, rgba(spec.sun.core, 0.5));
      disc.addColorStop(1, rgba(spec.sun.core, 0));
      g.fillStyle = disc;
      g.fillRect(sunX - r * 2, sunY - r * 2, r * 4, r * 4);
    }
  }
  yield;

  /* ---------------------------------------------------------- Layers */
  const layers: BuiltLayer[] = [];
  const stripCtx = context2d(strip);
  const stripData = stripCtx.createImageData(n, 1);

  // The light source used for shading, pushed out along the sun's offset.
  const lightX = sunX + (sunX - W / 2) * spec.sun.distance;
  const lightY = sunY + (sunY - H / 2) * spec.sun.distance;
  // Only peaks whose flanks reach the painted width matter.
  const minX = (-mx - spec.anchor * W) / H;
  const maxX = (W + mx - spec.anchor * W) / H;

  for (let index = 0; index < spec.layers.length; index++) {
    const layer = spec.layers[index];
    const lane = index * 7.13 + 3.1;
    const all = peaks[index];
    const keep: number[] = [];
    for (let p = 0; p < all.length; p += 4) {
      if (all[p] + all[p + 3] >= minX && all[p] - all[p + 2] <= maxX) {
        keep.push(all[p], all[p + 1], all[p + 2], all[p + 3]);
      }
    }
    const visible = Float32Array.from(keep);
    const ys = new Float32Array(n);
    let minY = Infinity;
    for (let k = 0; k < n; k++) {
      const rise = crestRise(spec, layer, visible, lane, -mx + k * STEP, W, H, noise);
      const y = (layer.base - rise) * H;
      ys[k] = y;
      if (y < minY) minY = y;
    }
    const y0 = Math.floor(minY - 16);
    const y1 = Math.ceil(H + my + 2);
    const lh = y1 - y0;
    // Hazy far ranges need no retina resolution.
    const ldpr = layer.depth < 0.3 ? Math.min(dpr, 1.25) : dpr;

    // Faces take their light from the broad shape of the crest above them;
    // the rim follows its finer detail.
    const faceLit = lightAlong(ys, Math.max(6, Math.round((H * 0.045) / STEP)), mx, lightX, lightY);
    const rimLit = lightAlong(ys, 2, mx, lightX, lightY);
    const near = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const dx = sunX - (-mx + k * STEP);
      const dy = sunY - ys[k];
      near[k] = Math.exp(-Math.hypot(dx, dy) / (spec.sun.reach * big));
    }

    // The haze gradient follows a heavily smoothed crest, so it does not
    // streak vertically under every jag.
    const smooth = new Float32Array(ys);
    blur1d(smooth, Math.max(4, Math.round((H * 0.06) / STEP)), 3);

    const canvas = makeCanvas(fullW * ldpr, lh * ldpr);
    owned.push(canvas);
    const g = context2d(canvas);
    g.setTransform(ldpr, 0, 0, ldpr, mx * ldpr, -y0 * ldpr);

    // Silhouette.
    g.beginPath();
    g.moveTo(-mx, y1);
    for (let k = 0; k < n; k++) g.lineTo(-mx + k * STEP, ys[k]);
    g.lineTo(-mx + (n - 1) * STEP, y1);
    g.closePath();
    g.fillStyle = rgba(layer.color);
    g.fill();

    // Body colour and face shading, per pixel at low resolution, laid over
    // the crisp silhouette.
    const texture = shadeLayer(spec, layer, index, ys, smooth, faceLit, near, {
      lightX,
      mx,
      y0,
      y1,
      W,
      H,
      noise,
    });
    g.globalCompositeOperation = "source-atop";
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(texture.canvas, -mx, y0, texture.width, texture.height);
    release(texture.canvas);

    // Rim light: stroke the whole crest once, then modulate it along x with
    // a one-pixel-tall alpha strip, so brightness varies smoothly with no
    // per-segment strokes (whose overlapping caps would bead).
    if (layer.rim > 0) {
      if (!scratch || scratch.width < canvas.width || scratch.height < canvas.height) {
        const wider = Math.max(scratch?.width ?? 0, canvas.width);
        const taller = Math.max(scratch?.height ?? 0, canvas.height);
        release(scratch);
        scratch = makeCanvas(wider, taller);
      }
      const scratchCanvas: HTMLCanvasElement = scratch;
      const s = context2d(scratchCanvas);

      const paintRim = (
        width: number,
        blurPx: number,
        alphaAt: (k: number) => number,
        operation: GlobalCompositeOperation
      ) => {
        s.setTransform(1, 0, 0, 1, 0, 0);
        s.globalCompositeOperation = "source-over";
        s.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
        s.setTransform(ldpr, 0, 0, ldpr, mx * ldpr, -y0 * ldpr);
        s.beginPath();
        s.moveTo(-mx, ys[0]);
        for (let k = 1; k < n; k++) s.lineTo(-mx + k * STEP, ys[k]);
        s.lineJoin = "round";
        s.lineCap = "round";
        s.lineWidth = width;
        s.strokeStyle = "#fff";
        if (blurPx > 0) {
          s.shadowColor = "#fff";
          s.shadowBlur = blurPx * ldpr;
        }
        s.stroke();
        s.shadowBlur = 0;
        s.shadowColor = "rgba(0,0,0,0)";

        // Colour and fade along x: light away from the sun, warm near it.
        const data = stripData.data;
        for (let k = 0; k < n; k++) {
          const t = near[k];
          data[k * 4] = spec.light[0] + (spec.warm[0] - spec.light[0]) * t;
          data[k * 4 + 1] = spec.light[1] + (spec.warm[1] - spec.light[1]) * t;
          data[k * 4 + 2] = spec.light[2] + (spec.warm[2] - spec.light[2]) * t;
          data[k * 4 + 3] = alphaAt(k) * 255;
        }
        stripCtx.putImageData(stripData, 0, 0);
        s.globalCompositeOperation = "source-in";
        s.imageSmoothingEnabled = true;
        s.drawImage(strip, -mx - STEP / 2, y0, n * STEP, lh);

        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = operation;
        g.drawImage(
          scratchCanvas,
          0,
          0,
          canvas.width,
          canvas.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        g.restore();
      };

      // Front-lit rims follow sun-facing slopes; backlit ones glow near the
      // sun whatever their slope. Either way they fade away from the sun.
      paintRim(
        layer.depth > 0.4 ? 2.4 : 1.8,
        0,
        (k) => {
          const facing = Math.max(0, rimLit[k]);
          const close = near[k];
          return clamp(
            layer.rim *
              (Math.pow(facing, 1.3) * (1 - spec.backlight) * 1.4 +
                close * close * spec.backlight * 1.6) *
              (0.25 + 0.75 * close),
            0,
            1
          );
        },
        "source-atop"
      );
      if (spec.halo > 0) {
        paintRim(
          1.2,
          8,
          (k) => clamp(near[k] * near[k] * near[k] * spec.halo * layer.rim * 2.2, 0, 1),
          "source-over"
        );
      }
    }
    g.globalCompositeOperation = "source-over";

    const fog = layer.fog ? buildFog(layer.fog, fullW + 48, H, noise3, index) : null;
    if (fog) owned.push(fog.canvas);
    layers.push({ canvas, y0, w: fullW, h: lh, depth: layer.depth, fog });
    yield;
  }

  const mask = buildMask(spec.fade, W, H);
  if (mask) owned.push(mask);
  complete = true;
  return {
    W,
    H,
    mx,
    my,
    sky,
    layers,
    mask,
    sunX,
    sunY,
    sunR: spec.sun.radius * big,
    bloomR: spec.bloom.radius * big,
  };
  } finally {
    release(scratch);
    release(strip);
    if (!complete) owned.forEach(release);
  }
}

interface ShadeContext {
  lightX: number;
  mx: number;
  y0: number;
  y1: number;
  W: number;
  H: number;
  noise: Noise2D;
}

/**
 * Per-pixel body colour for one range, at 3-4 CSS px per texel: the haze
 * gradient below the crest; faces lit or shadowed by the slope of the crest
 * above them, the boundary meandering down the face like a spur; and a soft
 * tonal mottle.
 */
function shadeLayer(
  spec: SceneSpec,
  layer: LayerSpec,
  index: number,
  ys: Float32Array,
  smooth: Float32Array,
  lit: Float32Array,
  near: Float32Array,
  c: ShadeContext
) {
  const { lightX, mx, y0, y1, H, noise } = c;
  const n = ys.length;
  const ts = layer.depth < 0.3 ? 4 : 3;
  const tw = Math.ceil((c.W + mx * 2) / ts) + 1;
  const th = Math.ceil((y1 - y0) / ts) + 1;
  const canvas = makeCanvas(tw, th);
  const g = context2d(canvas);
  const image = g.createImageData(tw, th);
  const data = image.data;

  const footPx = Math.max(1, layer.footDepth * H);
  const washPx = Math.max(1, layer.washDepth * H);
  const [cr, cg, cb] = layer.color;
  const [fr, fg, fb] = layer.foot;
  const [sr, sg, sb] = spec.shade;
  const shading = layer.wash > 0 || layer.mottle > 0;
  const last = n - 1.001;
  const offset = index * 17.3;

  for (let ty = 0; ty < th; ty++) {
    const y = y0 + (ty + 0.5) * ts;
    for (let tx = 0; tx < tw; tx++) {
      const x = -mx + (tx + 0.5) * ts;
      let fk = (x + mx) / STEP;
      fk = fk < 0 ? 0 : fk > last ? last : fk;
      const k0 = fk | 0;
      const f = fk - k0;
      const yc = ys[k0] + (ys[k0 + 1] - ys[k0]) * f;
      const d = y - yc;
      if (d < -ts * 3) continue;
      const dd = d > 0 ? d : 0;

      const ycs = smooth[k0] + (smooth[k0 + 1] - smooth[k0]) * f;
      const hz = smoothstep(-footPx * 0.15, footPx, y - ycs);
      let r = cr + (fr - cr) * hz;
      let gg = cg + (fg - cg) * hz;
      let b = cb + (fb - cb) * hz;

      if (shading) {
        let s = 0;
        if (layer.wash > 0) {
          // The terminator runs down from each summit, drifting toward the
          // sunward flank as it falls (so a lit face is a narrowing wedge,
          // not a curtain) and meandering more the further it goes, like a
          // spur with gullies.
          const depth = dd < 260 ? dd : 260;
          const drift = (lightX > x ? -1 : 1) * spec.slant * depth;
          const warp =
            noise(x * 0.014 + offset, y * 0.006) * (5 + depth * 0.2) +
            noise(x * 0.045 - offset, y * 0.02) * (2 + depth * 0.06);
          let fs = (x + drift + warp + mx) / STEP;
          fs = fs < 0 ? 0 : fs > last ? last : fs;
          const s0 = fs | 0;
          const sf = fs - s0;
          s = lit[s0] + (lit[s0 + 1] - lit[s0]) * sf;
        }
        if (layer.mottle > 0) {
          s += noise(x * 0.007 - offset, y * 0.01 + offset) * layer.mottle;
        }
        // An S-curve keeps the terminator fairly crisp, so lit and shaded
        // faces read as planes and the muddy in-between stays narrow.
        if (s > 0.04) {
          const a = smoothstep(0.04, 0.55, s) * layer.wash;
          // Lit faces glow near the crest and fade into the valley haze.
          const t = near[k0];
          const fade = smoothstep(0, washPx * 2.2, dd);
          const lr = spec.light[0] + (spec.warm[0] - spec.light[0]) * t;
          const lg = spec.light[1] + (spec.warm[1] - spec.light[1]) * t;
          const lb = spec.light[2] + (spec.warm[2] - spec.light[2]) * t;
          const fadeTo = Math.max(hz, 0.35);
          const hr = cr + (fr - cr) * fadeTo;
          const hg = cg + (fg - cg) * fadeTo;
          const hb = cb + (fb - cb) * fadeTo;
          r += (lr + (hr - lr) * fade - r) * a;
          gg += (lg + (hg - lg) * fade - gg) * a;
          b += (lb + (hb - lb) * fade - b) * a;
        } else if (s < -0.04) {
          // Shadowed faces deepen, less so where the haze has them.
          const a = smoothstep(0.04, 0.65, -s) * layer.wash * 0.62 * (1 - hz * 0.7);
          r += (sr - r) * a;
          gg += (sg - gg) * a;
          b += (sb - b) * a;
        }
      }

      const i = (ty * tw + tx) * 4;
      data[i] = r;
      data[i + 1] = gg;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }

  g.putImageData(image, 0, 0);
  return { canvas, width: tw * ts, height: th * ts };
}

/** A horizontally tileable band of wispy fog. */
function buildFog(
  fog: FogSpec,
  period: number,
  H: number,
  noise3: Noise3D,
  index: number
): BuiltFog {
  const h = fog.height * H * 2;
  const ts = 4;
  const tw = Math.max(2, Math.round(period / ts));
  const th = Math.max(2, Math.ceil(h / ts));
  const canvas = makeCanvas(tw, th);
  const g = context2d(canvas);
  const image = g.createImageData(tw, th);
  const data = image.data;
  // Sampling the noise around a cylinder makes the band wrap seamlessly.
  const radius = (tw * ts) / (fog.scale * TAU);
  const [r, gg, b] = fog.color;

  for (let ty = 0; ty < th; ty++) {
    const v = (ty + 0.5) / th;
    // Thin at the top, densest a little below the middle, soft at the foot.
    const profile =
      Math.pow(Math.sin(Math.PI * v), 1.4) * (0.6 + 0.4 * smoothstep(0, 0.7, v));
    const ny = ((ty * ts) / fog.scale) * 2.2 + index * 13.7;
    for (let tx = 0; tx < tw; tx++) {
      const angle = (tx / tw) * TAU;
      const value =
        fbm3(noise3, Math.cos(angle) * radius, ny, Math.sin(angle) * radius, 4) *
          0.5 +
        0.5;
      const a = smoothstep(0.28, 0.8, value) * profile;
      const i = (ty * tw + tx) * 4;
      data[i] = r;
      data[i + 1] = gg;
      data[i + 2] = b;
      data[i + 3] = a * 255;
    }
  }
  g.putImageData(image, 0, 0);

  return {
    canvas,
    y0: (fog.v - fog.height) * H,
    h,
    period: tw * ts,
    alpha: fog.alpha,
    speed: fog.speed,
  };
}

/** Alpha mask that fades the named edges out (smootherstep falloff). */
function buildMask(
  fade: SceneSpec["fade"],
  W: number,
  H: number
): HTMLCanvasElement | null {
  if (fade.left <= 0 && fade.top <= 0 && fade.right <= 0 && fade.bottom <= 0) {
    return null;
  }
  const mw = Math.max(2, Math.ceil(W / 4));
  const mh = Math.max(2, Math.ceil(H / 4));
  const canvas = makeCanvas(mw, mh);
  const g = context2d(canvas);
  const image = g.createImageData(mw, mh);
  const data = image.data;
  const edge = (t: number, f: number) => {
    if (f <= 0) return 1;
    const x = clamp(t / f, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
  };
  for (let y = 0; y < mh; y++) {
    const v = y / (mh - 1);
    const vy = edge(v, fade.top) * edge(1 - v, fade.bottom);
    for (let x = 0; x < mw; x++) {
      const u = x / (mw - 1);
      data[(y * mw + x) * 4 + 3] = vy * edge(u, fade.left) * edge(1 - u, fade.right) * 255;
    }
  }
  g.putImageData(image, 0, 0);
  return canvas;
}

function disposeBuilt(b: Built) {
  release(b.sky);
  release(b.mask);
  for (const layer of b.layers) {
    release(layer.canvas);
    release(layer.fog?.canvas);
  }
}

/* ================================================================== Scene */

function createRidgeScene(
  ctx: CanvasRenderingContext2D,
  spec: SceneSpec,
  env: CanvasEnvironment,
  interactive: boolean
): CanvasScene {
  const canvas = ctx.canvas;
  const seed = hashSeed(spec.seed);
  const noise = createNoise2D(mulberry32(seed));
  const noise3 = createNoise3D(mulberry32(seed ^ 0x9e3779b9));
  const peaks = spec.layers.map((layer, index) =>
    generatePeaks(layer, mulberry32(seed + (index + 1) * 0x6d2b79f5))
  );
  const random = mulberry32(seed ^ 0x85ebca6b);

  // Motes: u, v, drift (u/s), rise (v/s), phase, twinkle rate, size.
  const MOTE = 7;
  const moteCount = env.coarsePointer
    ? Math.ceil(spec.motes.count * 0.6)
    : spec.motes.count;
  const motes = new Float32Array(moteCount * MOTE);
  for (let i = 0; i < moteCount; i++) {
    const o = i * MOTE;
    motes[o] = random();
    motes[o + 1] = random();
    motes[o + 2] = (random() - 0.5) * 0.006;
    motes[o + 3] = 0.004 + random() * 0.008;
    motes[o + 4] = random() * TAU;
    motes[o + 5] = 0.4 + random() * 0.9;
    motes[o + 6] = 0.55 + random() * 0.6;
  }

  // Stars: u, v, size, base alpha, twinkle rate, phase. Denser toward the
  // right, where the night variant is not faded out.
  const STAR = 6;
  const stars = new Float32Array(spec.stars * STAR);
  for (let i = 0; i < spec.stars; i++) {
    const o = i * STAR;
    stars[o] = Math.sqrt(random());
    stars[o + 1] = Math.pow(random(), 1.3) * 0.72;
    stars[o + 2] = random() < 0.12 ? 2.2 + random() * 1.2 : 1 + random() * 1.1;
    stars[o + 3] = 0.25 + random() * 0.55;
    stars[o + 4] = 0.5 + random() * 1.6;
    stars[o + 5] = random() * TAU;
  }

  const moteSprite = makeGlowSprite(spec.motes.color, 32, 0.22);
  const starSprite = spec.stars > 0 ? makeGlowSprite([226, 240, 232], 16, 0.3) : null;
  const glowSprite = makeGlowSprite(spec.sun.core, 128, 0.2);
  const bloomSprite = makeGlowSprite(spec.bloom.color, 128, 0.3);

  let built: Built | null = null;
  let builder: Generator<void, Built | null, void> | null = null;
  let pending: { width: number; height: number; dpr: number } | null = null;
  let pendingAt = 0;
  let px = 0;
  let py = 0;
  let scrollShift = 0;
  let shown = false;

  const reveal = (reduced: boolean) => {
    if (shown) return;
    shown = true;
    if (reduced || typeof canvas.animate !== "function") return;
    const target = window.getComputedStyle(canvas).opacity || "1";
    canvas.animate([{ opacity: 0 }, { opacity: target }], {
      duration: 1400,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
  };

  return {
    resize(size: CanvasSize) {
      pending = { width: size.width, height: size.height, dpr: size.dpr };
      pendingAt = performance.now();
      // A paint for a size that is already stale is dropped (its canvases
      // are released by the generator's finally block).
      builder?.return(null);
      builder = null;
    },

    render(frame: CanvasFrame) {
      const reduced = frame.reducedMotion;
      if (
        pending &&
        !builder &&
        (!built || reduced || performance.now() - pendingAt > REBUILD_DELAY_MS)
      ) {
        builder = buildScene(
          spec,
          peaks,
          noise,
          noise3,
          pending.width,
          pending.height,
          pending.dpr
        );
        pending = null;
      }
      if (builder) {
        // Under reduced motion this is the only frame, so finish at once.
        const started = performance.now();
        let step = builder.next();
        while (!step.done && (reduced || performance.now() - started < BUILD_BUDGET_MS)) {
          step = builder.next();
        }
        if (step.done) {
          builder = null;
          if (step.value) {
            if (built) disposeBuilt(built);
            built = step.value;
          }
        }
      }
      const b = built;
      if (!b) return;

      const { ctx: c, time: t, delta: dt, width, height, dpr } = frame;
      const P = spec.parallax;

      // Pointer parallax, eased; scroll parallax, eased a little faster.
      let tx = 0;
      let ty = 0;
      if (interactive && !reduced && frame.pointer.active && !env.coarsePointer) {
        tx = clamp(frame.pointer.x, -1, 1);
        ty = clamp(frame.pointer.y, -1, 1);
      }
      const ease = frame.first ? 1 : 1 - Math.exp(-dt * 2.4);
      px += (tx - px) * ease;
      py += (ty - py) * ease;
      const scrollGoal = reduced ? 0 : clamp(frame.scroll.progress - 0.5, -0.5, 0.5);
      scrollShift +=
        (scrollGoal - scrollShift) * (frame.first ? 1 : 1 - Math.exp(-dt * 7));
      const sway = reduced
        ? 0
        : Math.sin(t * 0.13) * 0.6 + Math.sin(t * 0.051 + 1.7) * 0.4;
      const breath = reduced ? 0.5 : 0.5 + 0.5 * Math.sin((t * TAU) / 11);

      const offsetX = (depth: number) => (-px * P.x + sway * P.idle) * depth;
      const offsetY = (depth: number) =>
        -py * P.y * depth + scrollShift * P.scroll * (1 - depth);

      // Draw in the built layout's CSS px; while a resize is pending the
      // previous paint is stretched to the new size.
      c.setTransform((dpr * width) / b.W, 0, 0, (dpr * height) / b.H, 0, 0);
      c.globalAlpha = 1;
      c.imageSmoothingEnabled = true;

      // Sky. `copy` replaces the last frame, so no separate clear.
      const skyDepth = 0.04;
      c.globalCompositeOperation = "copy";
      c.drawImage(
        b.sky,
        -b.mx + offsetX(skyDepth),
        -b.my + offsetY(skyDepth),
        b.W + b.mx * 2,
        b.H + b.my * 2
      );
      c.globalCompositeOperation = "source-over";

      // The sun breathes.
      const sunR = b.sunR * 0.32 * (1 + 0.06 * breath);
      c.globalAlpha = (0.16 + 0.14 * breath) * spec.sun.alpha;
      c.drawImage(
        glowSprite,
        b.sunX + offsetX(skyDepth) - sunR,
        b.sunY + offsetY(skyDepth) - sunR,
        sunR * 2,
        sunR * 2
      );

      // Stars, twinkling.
      if (starSprite) {
        const sx = offsetX(0.02);
        const sy = offsetY(0.02);
        for (let i = 0; i < spec.stars; i++) {
          const o = i * STAR;
          const twinkle = reduced
            ? 0.8
            : 0.55 + 0.45 * Math.sin(t * stars[o + 4] + stars[o + 5]);
          const size = stars[o + 2];
          c.globalAlpha = stars[o + 3] * twinkle;
          c.drawImage(
            starSprite,
            stars[o] * b.W + sx - size,
            stars[o + 1] * b.H + sy - size,
            size * 2,
            size * 2
          );
        }
      }
      c.globalAlpha = 1;

      // Ranges, far to near, each followed by the fog in its valleys.
      for (let i = 0; i < b.layers.length; i++) {
        const layer = b.layers[i];
        c.drawImage(
          layer.canvas,
          -b.mx + offsetX(layer.depth),
          layer.y0 + offsetY(layer.depth),
          layer.w,
          layer.h
        );

        const fog = layer.fog;
        if (fog) {
          const depth = Math.min(1, layer.depth + 0.08);
          const drift = reduced ? 0 : t * fog.speed;
          const shift = ((drift % fog.period) + fog.period) % fog.period;
          const fx = -b.mx + offsetX(depth) - shift;
          const fy = fog.y0 + offsetY(depth);
          c.globalAlpha = fog.alpha * (0.86 + 0.14 * Math.sin(t * 0.17 + i * 1.9));
          c.drawImage(fog.canvas, fx, fy, fog.period, fog.h);
          c.drawImage(fog.canvas, fx + fog.period, fy, fog.period, fog.h);
          c.globalAlpha = 1;
        }
      }

      // Light scattered around the sun, breathing with it.
      c.globalCompositeOperation = "screen";
      const bloomR = b.bloomR * (0.96 + 0.08 * breath);
      c.globalAlpha = spec.bloom.alpha * (0.7 + 0.3 * breath);
      c.drawImage(
        bloomSprite,
        b.sunX + offsetX(0.3) - bloomR,
        b.sunY + offsetY(0.3) - bloomR,
        bloomR * 2,
        bloomR * 2
      );

      // Motes drift up and sway, twinkling.
      c.globalCompositeOperation = spec.motes.blend;
      const band = spec.motes.bottom - spec.motes.top;
      const mox = offsetX(0.9);
      const moy = offsetY(0.9);
      for (let i = 0; i < moteCount; i++) {
        const o = i * MOTE;
        let u = motes[o] + t * motes[o + 2];
        u -= Math.floor(u);
        let v = motes[o + 1] - t * motes[o + 3];
        v -= Math.floor(v);
        const life = Math.sin(Math.PI * v);
        const glimmer = 0.5 + 0.5 * Math.sin(t * motes[o + 5] + motes[o + 4]);
        const r = spec.motes.size * motes[o + 6];
        c.globalAlpha = spec.motes.alpha * life * (0.35 + 0.65 * glimmer);
        c.drawImage(
          moteSprite,
          u * b.W + Math.sin(t * 0.4 + motes[o + 4]) * 10 + mox - r,
          (spec.motes.top + v * band) * b.H + moy - r,
          r * 2,
          r * 2
        );
      }

      // Fade the named edges to transparent.
      c.globalAlpha = 1;
      if (b.mask) {
        c.globalCompositeOperation = "destination-in";
        c.drawImage(b.mask, 0, 0, b.W, b.H);
      }
      c.globalCompositeOperation = "source-over";

      reveal(reduced);
    },

    dispose() {
      builder?.return(null);
      builder = null;
      if (built) disposeBuilt(built);
      built = null;
      release(moteSprite);
      release(starSprite);
      release(glowSprite);
      release(bloomSprite);
    },
  };
}
