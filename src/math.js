// FlickerScope math: pure functions, no DOM. Runs the same in the browser and in Node.
//
// Pipeline (see README "How the flicker % is defined"):
//   pixels -> linear-light luminance per frame (whole frame and a grid of cells)
//   -> detrend each series with a centered ~0.3 s moving average (scene changes removed)
//   -> ratio r = L / trend
//   -> Percent Flicker (robust 95th/5th percentiles) and Flicker Index per series
//   -> headline = max(whole-frame %, area-weighted 75th percentile of cell %,
//                     half the strongest cell % that lasts through the whole window)

/** Default analysis settings. */
export const DEFAULTS = {
  grid: 4, // cells per side
  trendWindow: 0.3, // seconds, centered moving-average window for the trend
  hiPercentile: 95,
  loPercentile: 5,
  cellPercentile: 75, // area-weighted percentile across cells for the regional value
  darkCode: 20, // 8-bit sRGB: pixels whose brightest channel is below this are near-black
  clipCode: 250, // 8-bit sRGB: pixels with any channel at or above this are clipped
  minValid: 0.5, // a cell is usable when, on average over time, at least this fraction
  //                of its pixels is neither near-black nor clipped
  localWeight: 0.5, // weight of the strongest sustained single-cell flicker in the headline
};

/** Label thresholds on the headline percent: [upper bound, label]. */
export const LABELS = [
  [2, 'none'],
  [5, 'slight'],
  [12, 'visible'],
  [Infinity, 'strong'],
];

/** 8-bit sRGB code value -> linear light (0..1). */
export const SRGB_TO_LINEAR = /* @__PURE__ */ (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/**
 * Precompute which grid cell every pixel of a width x height frame belongs to.
 * Cells split the frame as evenly as integer pixels allow.
 */
export function makeLayout(width, height, grid = DEFAULTS.grid) {
  const cellOf = new Uint16Array(width * height);
  const area = new Float64Array(grid * grid);
  for (let y = 0; y < height; y++) {
    const row = Math.min(grid - 1, Math.floor((y * grid) / height));
    for (let x = 0; x < width; x++) {
      const c = row * grid + Math.min(grid - 1, Math.floor((x * grid) / width));
      cellOf[y * width + x] = c;
      area[c]++;
    }
  }
  return { width, height, grid, cellOf, area };
}

/**
 * Mean linear luminance per cell for one frame, plus the fraction of each cell's
 * pixels that carry signal (neither near-black nor clipped).
 * @param data RGBA (channels=4, e.g. ImageData.data) or RGB (channels=3) bytes
 */
export function measureFrame(data, layout, channels = 4, opts = {}) {
  const dark = opts.darkCode ?? DEFAULTS.darkCode;
  const clip = opts.clipCode ?? DEFAULTS.clipCode;
  const { cellOf, area } = layout;
  const n = cellOf.length;
  const sum = new Float64Array(area.length);
  const ok = new Float64Array(area.length);
  const lin = SRGB_TO_LINEAR;
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const c = cellOf[i];
    // Rec. 709 / sRGB luminance in linear light
    sum[c] += 0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b];
    const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (hi >= dark && hi < clip) ok[c]++;
  }
  for (let c = 0; c < area.length; c++) {
    sum[c] /= area[c] || 1;
    ok[c] /= area[c] || 1;
  }
  return { cells: sum, valid: ok };
}

/** Linear-interpolated percentile (p in 0..100) of an array of numbers. */
export function percentile(values, p) {
  const n = values.length;
  if (!n) return NaN;
  const s = Float64Array.from(values).sort();
  const k = (p / 100) * (n - 1);
  const i = Math.floor(k);
  return i + 1 < n ? s[i] + (k - i) * (s[i + 1] - s[i]) : s[n - 1];
}

/** Weighted percentile (p in 0..100): each value sits at the middle of its weight;
 *  linear interpolation between neighbours. */
export function weightedPercentile(values, weights, p) {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = idx.reduce((s, i) => s + weights[i], 0);
  let acc = 0, pm, pv;
  for (const i of idx) {
    const mid = (acc + weights[i] / 2) / total;
    if (p / 100 <= mid) return pm === undefined ? values[i] : pv + ((p / 100 - pm) / (mid - pm)) * (values[i] - pv);
    acc += weights[i];
    pm = mid;
    pv = values[i];
  }
  return pv ?? NaN;
}

/**
 * Split a series at hard cuts: a large frame-to-frame jump that persists
 * (the half-window means on both sides differ by most of the jump).
 * Flicker jumps do not persist, so they are not split.
 */
const logRatio = (a, b) => Math.log(Math.max(a, 1e-6) / Math.max(b, 1e-6));

export function findCuts(t, y, window = DEFAULTS.trendWindow) {
  const h = window / 2;
  const cuts = [];
  for (let k = 1; k < y.length; k++) {
    const jump = logRatio(y[k], y[k - 1]);
    if (Math.abs(jump) < 0.2) continue;
    let a = 0, na = 0, b = 0, nb = 0;
    for (let j = k - 1; j >= 0 && t[k - 1] - t[j] <= h; j--) a += y[j], na++;
    for (let j = k; j < y.length && t[j] - t[k] <= h; j++) b += y[j], nb++;
    // the step between the two half-windows must carry most of the jump
    if (na > 1 && nb > 1 && logRatio(b / nb, a / na) / jump >= 0.7) cuts.push(k);
  }
  return cuts;
}

/**
 * Frames far from the median of their neighbours in the window: more than 15 % away
 * in log terms, and more than 6 robust spreads (MAD) of the whole series. Steady
 * flicker raises the spread with it, so it is not flagged. Flashes are also rare,
 * so if more than 10 % of the frames qualify, it is flicker and none are flagged.
 */
export function outliers(t, y, bounds, h) {
  const d = new Float64Array(y.length);
  for (let s = 0; s + 1 < bounds.length; s++) {
    const lo = bounds[s], hi = bounds[s + 1];
    for (let i = lo, a = lo; i < hi; i++) {
      while (t[i] - t[a] > h) a++;
      const w = [];
      for (let j = a; j < hi && t[j] - t[i] <= h; j++) if (j !== i) w.push(y[j]);
      d[i] = w.length ? Math.abs(logRatio(y[i], percentile(w, 50))) : 0;
    }
  }
  const limit = Math.max(0.15, 6 * 1.4826 * percentile(d, 50));
  const flags = Array.from(d, (v) => v > limit);
  return flags.filter(Boolean).length > 0.1 * d.length ? flags.fill(false) : flags;
}

/**
 * Trend of a series: centered moving average over `window` seconds, using real
 * timestamps. Implemented as a local linear fit over the window, which equals the
 * plain moving average wherever the window is symmetric, and stays unbiased on
 * ramps at the clip edges and around dropped frames. Each shot between hard cuts
 * is detrended on its own. Outlier frames (a camera flash, a muzzle flash: far from
 * the moving median, see `outliers`) are left out of the average so they do not
 * smear into their neighbours; they keep their own ratio. `inner` marks frames whose
 * window is complete on both sides (the statistics prefer these; edge frames rest on
 * a one-sided fit).
 * @returns {{trend: Float64Array, ratio: Float64Array, inner: Uint8Array}}
 */
export function detrend(t, y, window = DEFAULTS.trendWindow) {
  const n = y.length;
  const trend = new Float64Array(n);
  const ratio = new Float64Array(n);
  const inner = new Uint8Array(n);
  const h = window / 2 + 1e-9;
  const bounds = [0, ...findCuts(t, y, window), n];
  const skip = outliers(t, y, bounds, h);
  for (let s = 0; s + 1 < bounds.length; s++) {
    const lo = bounds[s], hi = bounds[s + 1];
    for (let i = lo; i < hi; i++) {
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, j = i;
      while (j > lo && t[i] - t[j - 1] <= h) j--;
      for (; j < hi && t[j] - t[i] <= h; j++) {
        if (skip[j]) continue;
        const x = t[j] - t[i];
        sw++, sx += x, sy += y[j], sxx += x * x, sxy += x * y[j];
      }
      const den = sw * sxx - sx * sx;
      // intercept of the local line at t[i]; plain mean if the fit is degenerate
      const v = den > 1e-12 ? (sy * sxx - sx * sxy) / den : sw ? sy / sw : y[i];
      trend[i] = v;
      ratio[i] = v > 1e-9 ? y[i] / v : 1;
      inner[i] = Math.min(t[i] - t[lo], t[hi - 1] - t[i]) >= 0.48 * window ? 1 : 0;
    }
  }
  return { trend, ratio, inner };
}

/**
 * Percent Flicker and Flicker Index of one detrended series. Uses the frames with a
 * complete trend window when there are enough of them (at least 8 and half the frames).
 */
export function seriesFlicker(t, ratio, inner, o = DEFAULTS) {
  let r = ratio, tt = t;
  const keep = [];
  for (let i = 0; i < ratio.length; i++) if (inner && inner[i]) keep.push(i);
  if (keep.length >= 8 && keep.length >= ratio.length / 2) {
    r = keep.map((i) => ratio[i]);
    tt = keep.map((i) => t[i]);
  }
  return { percent: percentFlicker(r, o.loPercentile, o.hiPercentile), flickerIndex: flickerIndex(r, tt) };
}

/** IEEE 1789 Percent Flicker, 100*(hi-lo)/(hi+lo), with robust percentiles for hi/lo. */
export function percentFlicker(ratio, lo = DEFAULTS.loPercentile, hi = DEFAULTS.hiPercentile) {
  const a = percentile(ratio, hi), b = percentile(ratio, lo);
  return a + b > 0 ? (100 * (a - b)) / (a + b) : 0;
}

/** IEEE 1789 Flicker Index: area above the mean divided by the total area (0..1).
 *  With timestamps, each sample counts for half the gap to each neighbour. */
export function flickerIndex(ratio, t) {
  const n = ratio.length;
  const w = (i) => (t && n > 1 ? t[Math.min(i + 1, n - 1)] - t[Math.max(i - 1, 0)] : 1);
  let sw = 0, s = 0, above = 0;
  for (let i = 0; i < n; i++) sw += w(i), s += w(i) * ratio[i];
  const mean = s / sw;
  for (let i = 0; i < n; i++) if (ratio[i] > mean) above += w(i) * (ratio[i] - mean);
  return s > 0 ? above / s : 0;
}

/** Median frame rate of a timestamp series. */
export function frameRate(t) {
  const d = [];
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) d.push(t[i] - t[i - 1]);
  const m = percentile(d, 50);
  return m > 0 ? 1 / m : 0;
}

/**
 * Periodogram of a residual (ratio - 1) at real, possibly uneven timestamps,
 * with a Hann taper. Returns power at frequencies from fmin to fmax.
 */
export function periodogram(t, x, fmin, fmax, step) {
  const n = x.length;
  const T = t[n - 1] - t[0] || 1;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  const v = Array.from(x, (xi, i) => (xi - m) * (1 - Math.cos((2 * Math.PI * (t[i] - t[0])) / T)));
  const f = [], p = [];
  for (let fr = fmin; fr <= fmax + 1e-9; fr += step) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * fr * t[i];
      re += v[i] * Math.cos(a);
      im += v[i] * Math.sin(a);
    }
    f.push(fr);
    p.push(re * re + im * im);
  }
  return { f, p };
}

/**
 * Dominant rhythm of a set of residual spectra (summed). The peak must stand clearly
 * above the band average (`minProminence` times) or null is returned.
 */
function peakOf(spec, minProminence) {
  const { f, p } = spec;
  let k = 0, mean = 0;
  for (let i = 0; i < p.length; i++) { mean += p[i]; if (p[i] > p[k]) k = i; }
  mean /= p.length || 1;
  if (!(p[k] > 0) || p[k] < minProminence * mean) return null;
  let hz = f[k];
  if (k > 0 && k + 1 < p.length) {
    const den = p[k - 1] - 2 * p[k] + p[k + 1];
    if (den < 0) hz += (0.5 * (p[k - 1] - p[k + 1]) / den) * (f[1] - f[0]);
  }
  return hz;
}

/**
 * Dominant visible flicker rhythm in Hz. This is the rhythm as recorded by the
 * camera (aliased by the frame rate), not the light's true frequency: a 100 Hz
 * light filmed at 30 fps shows up near 10 Hz.
 * `groups` are tried in order (for example the whole-frame residual, then the
 * usable cells); each is a list of [residual, weight] pairs whose spectra are
 * summed. The first group with a clear peak wins.
 */
export function dominantHz(t, groups, minProminence = 8) {
  const n = t.length;
  const T = t[n - 1] - t[0];
  const fmax = frameRate(t) / 2;
  const fmin = Math.max(0.5, 2 / T);
  if (n < 8 || !(fmax > fmin)) return null;
  const step = Math.min(0.05, 1 / (4 * T));
  for (const group of groups) {
    let sum;
    for (const [x, w] of group) {
      const s = periodogram(t, x, fmin, fmax, step);
      if (!sum) sum = { f: s.f, p: s.p.map((v) => v * w) };
      else s.p.forEach((v, i) => (sum.p[i] += v * w));
    }
    const hz = sum && peakOf(sum, minProminence);
    if (hz != null) return hz;
  }
  return null;
}

/** Plain-language label for a headline percent. */
export function labelFor(percent) {
  for (const [max, name] of LABELS) if (percent < max) return name;
  return 'strong';
}

const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

/**
 * Analyze a sequence of measured frames.
 * @param frames [{ t: seconds, cells: number[], valid: number[] }] as returned by measureFrame plus t
 * @param layout from makeLayout (cell areas and grid)
 */
export function analyze(frames, layout, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const warnings = [];
  // keep strictly increasing timestamps
  const fr = [];
  for (const f of frames) if (!fr.length || f.t > fr[fr.length - 1].t) fr.push(f);
  const n = fr.length;
  const nc = layout.area.length;
  const t0 = n ? fr[0].t : 0;
  const t = fr.map((f) => f.t - t0);
  const seconds = n > 1 ? t[n - 1] - t[0] + (t[n - 1] - t[0]) / (n - 1) : 0;
  if (n < 8) warnings.push('FEW_FRAMES');

  // usable cells: enough pixels with signal, averaged over time
  const totalArea = layout.area.reduce((a, b) => a + b, 0);
  const usable = [];
  const validFrac = new Float64Array(nc);
  const meanLuma = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    for (const f of fr) { validFrac[c] += f.valid[c]; meanLuma[c] += f.cells[c]; }
    validFrac[c] /= n || 1;
    meanLuma[c] /= n || 1;
    if (validFrac[c] >= o.minValid) usable.push(c);
  }
  let usedArea = 0;
  for (const c of usable) usedArea += layout.area[c];
  const usableArea = usedArea / totalArea;
  if (!usableArea) warnings.push(meanLuma.reduce((a, b) => a + b) / nc < 0.05 ? 'TOO_DARK' : 'CLIPPED');
  else if (usableArea < 0.25) warnings.push('LOW_USABLE_AREA');

  // whole-frame series over the usable cells (all cells if none are usable)
  const cellsForWhole = usable.length ? usable : [...Array(nc).keys()];
  let wArea = 0;
  for (const c of cellsForWhole) wArea += layout.area[c];
  const brightness = fr.map((f) => {
    let s = 0;
    for (const c of cellsForWhole) s += f.cells[c] * layout.area[c];
    return s / wArea;
  });

  const whole = n >= 3 ? detrend(t, brightness, o.trendWindow) : { trend: Float64Array.from(brightness), ratio: new Float64Array(n).fill(1) };
  const ws = n >= 3 ? seriesFlicker(t, whole.ratio, whole.inner, o) : { percent: 0, flickerIndex: 0 };
  const wholePF = ws.percent;
  const wholeFI = ws.flickerIndex;

  const regions = [];
  const cellIdx = [], cellRatios = [], cellW = [], cellPF = [], cellFI = [];
  let local = 0, localCell = -1;
  const half = n >> 1;
  for (let c = 0; c < nc; c++) {
    const row = Math.floor(c / layout.grid), col = c % layout.grid;
    const reg = {
      row, col,
      x: col / layout.grid, y: row / layout.grid, w: 1 / layout.grid, h: 1 / layout.grid,
      usable: usable.includes(c),
      brightness: round(meanLuma[c], 4),
      percent: null, flickerIndex: null, sustained: null,
    };
    if (reg.usable && n >= 3) {
      const { ratio, inner } = detrend(t, fr.map((f) => f.cells[c]), o.trendWindow);
      const { percent: pf, flickerIndex: fi } = seriesFlicker(t, ratio, inner, o);
      // sustained: flicker present in both halves of the window (motion passing
      // through a cell usually is not)
      const sus = n >= 16
        ? Math.min(
            seriesFlicker(t.slice(0, half), ratio.slice(0, half), inner.slice(0, half), o).percent,
            seriesFlicker(t.slice(half), ratio.slice(half), inner.slice(half), o).percent,
          )
        : 0;
      reg.percent = round(pf, 2);
      reg.flickerIndex = round(fi, 4);
      reg.sustained = round(sus, 2);
      cellIdx.push(c);
      cellRatios.push(Array.from(ratio, (v) => v - 1));
      cellW.push(layout.area[c]);
      cellPF.push(pf);
      cellFI.push(fi);
      if (o.localWeight * sus > local) { local = o.localWeight * sus; localCell = c; }
    }
    regions.push(reg);
  }

  const regionalPF = cellPF.length ? weightedPercentile(cellPF, cellW, o.cellPercentile) : 0;
  const regionalFI = cellFI.length ? weightedPercentile(cellFI, cellW, o.cellPercentile) : 0;
  const percent = Math.max(wholePF, regionalPF, local);
  const fi = Math.max(wholeFI, regionalFI);
  const label = labelFor(percent);

  // rhythm of the residual
  let hz = null;
  if (label !== 'none' && n >= 8) {
    const wholeRes = [[Array.from(whole.ratio, (v) => v - 1), 1]];
    const cellsRes = cellRatios.map((x, k) => [x, cellW[k]]);
    const k = cellIdx.indexOf(localCell);
    // whichever term leads the headline is asked first
    const order = local > Math.max(wholePF, regionalPF) && k >= 0
      ? [[cellsRes[k]], cellsRes, wholeRes]
      : regionalPF > wholePF ? [cellsRes, wholeRes] : [wholeRes, cellsRes];
    hz = dominantHz(t, order);
  }

  const fps = frameRate(t);
  if (fps && fps < 20) warnings.push('LOW_FRAME_RATE');

  return {
    percent: round(percent, 1),
    flickerIndex: round(fi, 4),
    hz: hz == null ? null : round(hz, 1),
    label,
    frames: n,
    seconds: round(seconds, 3),
    fps: round(fps, 2),
    usableArea: round(usableArea, 3),
    whole: { percent: round(wholePF, 2), flickerIndex: round(wholeFI, 4) },
    regional: { percent: round(regionalPF, 2), flickerIndex: round(regionalFI, 4) },
    local: { percent: round(local, 2), region: localCell >= 0 && local > 0 ? localCell : null },
    regions,
    series: { t, brightness, trend: Array.from(whole.trend) },
    warnings,
  };
}
