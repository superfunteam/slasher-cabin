/**
 * Deterministic RNG + hash utilities.
 * The whole world must be reproducible from a seed so screenshot regression works.
 * Owned by: Engine agent.
 */

/** Mix a 32-bit integer into a well-distributed 32-bit integer. */
export function hashInt(x) {
  x |= 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** Deterministic [0,1) from two integers. Use for spatial scatter. */
export function hash2(x, y) {
  return hashInt(Math.imul(hashInt(x | 0), 0x9e3779b1) ^ hashInt(y | 0)) / 4294967296;
}

/** Deterministic [0,1) from three integers. */
export function hash3(x, y, z) {
  return hashInt(
    Math.imul(hashInt(x | 0), 0x9e3779b1) ^
    Math.imul(hashInt(y | 0), 0x85ebca6b) ^
    hashInt(z | 0),
  ) / 4294967296;
}

/** Deterministic [0,1) from a string. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** "SLASCAB" in valid hex. The canonical world seed. */
export const DEFAULT_SEED = 0x51a5cab;

/**
 * sfc32 — fast, tiny, statistically solid. Period ~2^128.
 */
export class Rand {
  constructor(seed = DEFAULT_SEED) {
    this.seed(seed);
  }

  seed(s) {
    if (typeof s === 'string') s = Math.floor(hashStr(s) * 4294967296);
    const a = hashInt(s);
    const b = hashInt(a ^ 0x9e3779b9);
    const c = hashInt(b ^ 0x85ebca6b);
    const d = hashInt(c ^ 0xc2b2ae35);
    this._a = a; this._b = b; this._c = c; this._d = d;
    // Discard the first few to wash out seed correlation.
    for (let i = 0; i < 12; i++) this.next();
    this._spare = null;
    return this;
  }

  /** float in [0,1) */
  next() {
    let { _a: a, _b: b, _c: c, _d: d } = this;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    d = (d + 1) >>> 0;
    const r = (t + d) >>> 0;
    this._a = a; this._b = b; this._c = c; this._d = d;
    return r / 4294967296;
  }

  /** float in [a,b) */
  range(a, b) { return a + (b - a) * this.next(); }

  /** integer in [a,b] inclusive */
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }

  /** true with probability p */
  chance(p) { return this.next() < p; }

  /** random element */
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  /** weighted pick — weights need not sum to 1 */
  weighted(items, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Fisher-Yates, in place, returns the array */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Box-Muller normal */
  gauss(mu = 0, sigma = 1) {
    if (this._spare !== null) {
      const s = this._spare; this._spare = null;
      return mu + sigma * s;
    }
    let u, v, s;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * m;
    return mu + sigma * u * m;
  }

  /** Uniform point on a unit disc — for scatter without clumping at the centre. */
  onDisc(out = { x: 0, y: 0 }) {
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next());
    out.x = Math.cos(t) * r;
    out.y = Math.sin(t) * r;
    return out;
  }

  /** Fork a child generator — deterministic, independent stream. */
  fork(tag = 0) {
    return new Rand(hashInt(this._a ^ hashInt(typeof tag === 'string' ? Math.floor(hashStr(tag) * 4294967296) : tag)));
  }
}

/** Classic 2D value noise with smoothstep interpolation. Deterministic. */
export function valueNoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal brownian motion over valueNoise2. */
export function fbm2(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — for mountain silhouettes and bark. */
export function ridged2(x, y, octaves = 5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export default Rand;
