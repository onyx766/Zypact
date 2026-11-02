/**
 * Seeded randomness and gradient noise for the landing page's procedural art.
 *
 * Everything here is deterministic for a given seed, so a canvas that is
 * rebuilt on resize, or mounted twice under React StrictMode, draws the same
 * landscape every time. The factories build their lookup tables once as typed
 * arrays; the noise functions and the fractal helpers below allocate nothing
 * per call, so they are safe inside per-frame and per-pixel loops.
 *
 * Simplex noise after Stefan Gustavson's public-domain reference
 * implementation ("Simplex noise demystified", 2005).
 */

export type Random = () => number;
export type Noise2D = (x: number, y: number) => number;
export type Noise3D = (x: number, y: number, z: number) => number;

/* ------------------------------------------------------------------ PRNG */

/** mulberry32: a tiny, fast 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: turns a label such as "dawn" into a stable 32-bit seed. */
export function hashSeed(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* ------------------------------------------------------------- Shaping */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep: 0 at or below `edge0`, 1 at or above `edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------ Simplex */

// The 12 edge midpoints of a cube; 2D noise uses their x/y components.
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0,
  -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

/** A seeded permutation of 0..255, doubled so lookups never need wrapping. */
function buildPermutation(random: Random): Uint8Array {
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const r = Math.floor(random() * (i + 1));
    const swap = base[i];
    base[i] = base[r];
    base[r] = swap;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  return perm;
}

/** Seeded 2D simplex noise. Output is roughly in [-1, 1]. */
export function createNoise2D(random: Random): Noise2D {
  const perm = buildPermutation(random);
  // Gradient components pre-resolved per permutation slot.
  const gx = new Float64Array(512);
  const gy = new Float64Array(512);
  for (let i = 0; i < 512; i++) {
    const g = (perm[i] % 12) * 3;
    gx[i] = GRAD3[g];
    gy[i] = GRAD3[g + 1];
  }

  return function noise2D(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = ii + perm[jj];
      t0 *= t0;
      n += t0 * t0 * (gx[g] * x0 + gy[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = ii + i1 + perm[jj + j1];
      t1 *= t1;
      n += t1 * t1 * (gx[g] * x1 + gy[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = ii + 1 + perm[jj + 1];
      t2 *= t2;
      n += t2 * t2 * (gx[g] * x2 + gy[g] * y2);
    }
    return 70 * n;
  };
}

/** Seeded 3D simplex noise. Output is roughly in [-1, 1]. */
export function createNoise3D(random: Random): Noise3D {
  const perm = buildPermutation(random);
  const gx = new Float64Array(512);
  const gy = new Float64Array(512);
  const gz = new Float64Array(512);
  for (let i = 0; i < 512; i++) {
    const g = (perm[i] % 12) * 3;
    gx[i] = GRAD3[g];
    gy[i] = GRAD3[g + 1];
    gz[i] = GRAD3[g + 2];
  }

  return function noise3D(x: number, y: number, z: number): number {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    // Which of the six tetrahedra of the skewed cube holds the point.
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = ii + perm[jj + perm[kk]];
      t0 *= t0;
      n += t0 * t0 * (gx[g] * x0 + gy[g] * y0 + gz[g] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = ii + i1 + perm[jj + j1 + perm[kk + k1]];
      t1 *= t1;
      n += t1 * t1 * (gx[g] * x1 + gy[g] * y1 + gz[g] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = ii + i2 + perm[jj + j2 + perm[kk + k2]];
      t2 *= t2;
      n += t2 * t2 * (gx[g] * x2 + gy[g] * y2 + gz[g] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = ii + 1 + perm[jj + 1 + perm[kk + 1]];
      t3 *= t3;
      n += t3 * t3 * (gx[g] * x3 + gy[g] * y3 + gz[g] * z3);
    }
    return 32 * n;
  };
}

/* ------------------------------------------------------------ Fractals */

/**
 * Fractional Brownian motion: `octaves` layers of noise, each `lacunarity`
 * times the frequency and `gain` times the amplitude of the last. Normalised,
 * so the output stays roughly in [-1, 1] whatever the octave count.
 */
export function fbm2(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** 3D fBm, as {@link fbm2}. The third axis is usually time. */
export function fbm3(
  noise: Noise3D,
  x: number,
  y: number,
  z: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal noise in [0, 1]. Folding each octave about zero
 * (`1 - |n|`) turns the noise's zero crossings into sharp crests, and
 * weighting every octave by the one before keeps fine detail on the crests
 * while the valleys stay smooth — the silhouette of eroded mountains.
 * `sharpness` raises each folded octave to a power: higher is pointier.
 */
export function ridged2(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
  sharpness = 2
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * freq, y * freq));
    n = Math.pow(n, sharpness);
    const contribution = n * weight;
    sum += amp * contribution;
    norm += amp;
    weight = clamp(contribution * 1.6, 0, 1);
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
