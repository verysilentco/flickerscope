/*! flickerscope v1.0.0 | MIT License | (c) 2026 Silent Co, LLC */

// src/math.js
var DEFAULTS = {
  grid: 4,
  // cells per side
  trendWindow: 0.3,
  // seconds, centered moving-average window for the trend
  hiPercentile: 95,
  loPercentile: 5,
  cellPercentile: 75,
  // area-weighted percentile across cells for the regional value
  darkCode: 20,
  // 8-bit sRGB: pixels whose brightest channel is below this are near-black
  clipCode: 250,
  // 8-bit sRGB: pixels with any channel at or above this are clipped
  minValid: 0.5,
  // a cell is usable when, on average over time, at least this fraction
  //                of its pixels is neither near-black nor clipped
  localWeight: 0.5
  // weight of the strongest sustained single-cell flicker in the headline
};
var LABELS = [
  [2, "none"],
  [5, "slight"],
  [12, "visible"],
  [Infinity, "strong"]
];
var SRGB_TO_LINEAR = /* @__PURE__ */ (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();
function makeLayout(width, height, grid = DEFAULTS.grid) {
  const cellOf = new Uint16Array(width * height);
  const area = new Float64Array(grid * grid);
  for (let y = 0; y < height; y++) {
    const row = Math.min(grid - 1, Math.floor(y * grid / height));
    for (let x = 0; x < width; x++) {
      const c = row * grid + Math.min(grid - 1, Math.floor(x * grid / width));
      cellOf[y * width + x] = c;
      area[c]++;
    }
  }
  return { width, height, grid, cellOf, area };
}
function measureFrame(data, layout, channels = 4, opts = {}) {
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
    sum[c] += 0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b];
    const hi = r > g ? r > b ? r : b : g > b ? g : b;
    if (hi >= dark && hi < clip) ok[c]++;
  }
  for (let c = 0; c < area.length; c++) {
    sum[c] /= area[c] || 1;
    ok[c] /= area[c] || 1;
  }
  return { cells: sum, valid: ok };
}
function percentile(values, p) {
  const n = values.length;
  if (!n) return NaN;
  const s = Float64Array.from(values).sort();
  const k = p / 100 * (n - 1);
  const i = Math.floor(k);
  return i + 1 < n ? s[i] + (k - i) * (s[i + 1] - s[i]) : s[n - 1];
}
function weightedPercentile(values, weights, p) {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = idx.reduce((s, i) => s + weights[i], 0);
  let acc = 0, pm, pv;
  for (const i of idx) {
    const mid = (acc + weights[i] / 2) / total;
    if (p / 100 <= mid) return pm === void 0 ? values[i] : pv + (p / 100 - pm) / (mid - pm) * (values[i] - pv);
    acc += weights[i];
    pm = mid;
    pv = values[i];
  }
  return pv ?? NaN;
}
var logRatio = (a, b) => Math.log(Math.max(a, 1e-6) / Math.max(b, 1e-6));
function findCuts(t, y, window = DEFAULTS.trendWindow) {
  const h = window / 2;
  const cuts = [];
  for (let k = 1; k < y.length; k++) {
    const jump = logRatio(y[k], y[k - 1]);
    if (Math.abs(jump) < 0.2) continue;
    let a = 0, na = 0, b = 0, nb = 0;
    for (let j = k - 1; j >= 0 && t[k - 1] - t[j] <= h; j--) a += y[j], na++;
    for (let j = k; j < y.length && t[j] - t[k] <= h; j++) b += y[j], nb++;
    if (na > 1 && nb > 1 && logRatio(b / nb, a / na) / jump >= 0.7) cuts.push(k);
  }
  return cuts;
}
function outliers(t, y, bounds, h) {
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
function detrend(t, y, window = DEFAULTS.trendWindow) {
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
      const v = den > 1e-12 ? (sy * sxx - sx * sxy) / den : sw ? sy / sw : y[i];
      trend[i] = v;
      ratio[i] = v > 1e-9 ? y[i] / v : 1;
      inner[i] = Math.min(t[i] - t[lo], t[hi - 1] - t[i]) >= 0.48 * window ? 1 : 0;
    }
  }
  return { trend, ratio, inner };
}
function seriesFlicker(t, ratio, inner, o = DEFAULTS) {
  let r = ratio, tt = t;
  const keep = [];
  for (let i = 0; i < ratio.length; i++) if (inner && inner[i]) keep.push(i);
  if (keep.length >= 8 && keep.length >= ratio.length / 2) {
    r = keep.map((i) => ratio[i]);
    tt = keep.map((i) => t[i]);
  }
  return { percent: percentFlicker(r, o.loPercentile, o.hiPercentile), flickerIndex: flickerIndex(r, tt) };
}
function percentFlicker(ratio, lo = DEFAULTS.loPercentile, hi = DEFAULTS.hiPercentile) {
  const a = percentile(ratio, hi), b = percentile(ratio, lo);
  return a + b > 0 ? 100 * (a - b) / (a + b) : 0;
}
function flickerIndex(ratio, t) {
  const n = ratio.length;
  const w = (i) => t && n > 1 ? t[Math.min(i + 1, n - 1)] - t[Math.max(i - 1, 0)] : 1;
  let sw = 0, s = 0, above = 0;
  for (let i = 0; i < n; i++) sw += w(i), s += w(i) * ratio[i];
  const mean = s / sw;
  for (let i = 0; i < n; i++) if (ratio[i] > mean) above += w(i) * (ratio[i] - mean);
  return s > 0 ? above / s : 0;
}
function frameRate(t) {
  const d = [];
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) d.push(t[i] - t[i - 1]);
  const m = percentile(d, 50);
  return m > 0 ? 1 / m : 0;
}
function periodogram(t, x, fmin, fmax, step) {
  const n = x.length;
  const T = t[n - 1] - t[0] || 1;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  const v = Array.from(x, (xi, i) => (xi - m) * (1 - Math.cos(2 * Math.PI * (t[i] - t[0]) / T)));
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
function peakOf(spec, minProminence) {
  const { f, p } = spec;
  let k = 0, mean = 0;
  for (let i = 0; i < p.length; i++) {
    mean += p[i];
    if (p[i] > p[k]) k = i;
  }
  mean /= p.length || 1;
  if (!(p[k] > 0) || p[k] < minProminence * mean) return null;
  let hz = f[k];
  if (k > 0 && k + 1 < p.length) {
    const den = p[k - 1] - 2 * p[k] + p[k + 1];
    if (den < 0) hz += 0.5 * (p[k - 1] - p[k + 1]) / den * (f[1] - f[0]);
  }
  return hz;
}
function dominantHz(t, groups, minProminence = 8) {
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
      else s.p.forEach((v, i) => sum.p[i] += v * w);
    }
    const hz = sum && peakOf(sum, minProminence);
    if (hz != null) return hz;
  }
  return null;
}
function labelFor(percent) {
  for (const [max, name] of LABELS) if (percent < max) return name;
  return "strong";
}
var round = (v, d) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v;
function analyze(frames, layout, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const warnings = [];
  const fr = [];
  for (const f of frames) if (!fr.length || f.t > fr[fr.length - 1].t) fr.push(f);
  const n = fr.length;
  const nc = layout.area.length;
  const t0 = n ? fr[0].t : 0;
  const t = fr.map((f) => f.t - t0);
  const seconds = n > 1 ? t[n - 1] - t[0] + (t[n - 1] - t[0]) / (n - 1) : 0;
  if (n < 8) warnings.push("FEW_FRAMES");
  const totalArea = layout.area.reduce((a, b) => a + b, 0);
  const usable = [];
  const validFrac = new Float64Array(nc);
  const meanLuma = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    for (const f of fr) {
      validFrac[c] += f.valid[c];
      meanLuma[c] += f.cells[c];
    }
    validFrac[c] /= n || 1;
    meanLuma[c] /= n || 1;
    if (validFrac[c] >= o.minValid) usable.push(c);
  }
  let usedArea = 0;
  for (const c of usable) usedArea += layout.area[c];
  const usableArea = usedArea / totalArea;
  if (!usableArea) warnings.push(meanLuma.reduce((a, b) => a + b) / nc < 0.05 ? "TOO_DARK" : "CLIPPED");
  else if (usableArea < 0.25) warnings.push("LOW_USABLE_AREA");
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
      row,
      col,
      x: col / layout.grid,
      y: row / layout.grid,
      w: 1 / layout.grid,
      h: 1 / layout.grid,
      usable: usable.includes(c),
      brightness: round(meanLuma[c], 4),
      percent: null,
      flickerIndex: null,
      sustained: null
    };
    if (reg.usable && n >= 3) {
      const { ratio, inner } = detrend(t, fr.map((f) => f.cells[c]), o.trendWindow);
      const { percent: pf, flickerIndex: fi2 } = seriesFlicker(t, ratio, inner, o);
      const sus = n >= 16 ? Math.min(
        seriesFlicker(t.slice(0, half), ratio.slice(0, half), inner.slice(0, half), o).percent,
        seriesFlicker(t.slice(half), ratio.slice(half), inner.slice(half), o).percent
      ) : 0;
      reg.percent = round(pf, 2);
      reg.flickerIndex = round(fi2, 4);
      reg.sustained = round(sus, 2);
      cellIdx.push(c);
      cellRatios.push(Array.from(ratio, (v) => v - 1));
      cellW.push(layout.area[c]);
      cellPF.push(pf);
      cellFI.push(fi2);
      if (o.localWeight * sus > local) {
        local = o.localWeight * sus;
        localCell = c;
      }
    }
    regions.push(reg);
  }
  const regionalPF = cellPF.length ? weightedPercentile(cellPF, cellW, o.cellPercentile) : 0;
  const regionalFI = cellFI.length ? weightedPercentile(cellFI, cellW, o.cellPercentile) : 0;
  const percent = Math.max(wholePF, regionalPF, local);
  const fi = Math.max(wholeFI, regionalFI);
  const label = labelFor(percent);
  let hz = null;
  if (label !== "none" && n >= 8) {
    const wholeRes = [[Array.from(whole.ratio, (v) => v - 1), 1]];
    const cellsRes = cellRatios.map((x, k2) => [x, cellW[k2]]);
    const k = cellIdx.indexOf(localCell);
    const order = local > Math.max(wholePF, regionalPF) && k >= 0 ? [[cellsRes[k]], cellsRes, wholeRes] : regionalPF > wholePF ? [cellsRes, wholeRes] : [wholeRes, cellsRes];
    hz = dominantHz(t, order);
  }
  const fps = frameRate(t);
  if (fps && fps < 20) warnings.push("LOW_FRAME_RATE");
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
    warnings
  };
}

// src/index.js
var version = true ? "1.0.0" : "dev";
var DROP = " Download the clip and drop the file in instead.";
var MESSAGES = {
  CROSS_ORIGIN: "This website does not allow reading this video's pixels (no CORS permission, or DRM), so it cannot be measured in the browser." + DROP,
  PROTECTED: "This video is DRM protected, so its pixels cannot be read.",
  LOAD_FAILED: "The video could not be loaded. If it is on another website, that site may not allow reading it (CORS)." + DROP,
  NO_FRAMES: "Too few frames could be read. In play mode the page must stay visible.",
  PLAYBACK_BLOCKED: "The browser did not let the video play. Click the page and try again.",
  ABORTED: "Cancelled.",
  TIMEOUT: "The video stopped loading.",
  BAD_INPUT: "Expected a video element, a File or Blob, or a URL."
};
var FlickerScopeError = class extends Error {
  constructor(code, message, cause) {
    super(message || MESSAGES[code] || code);
    this.name = "FlickerScopeError";
    this.code = code;
    if (cause) this.cause = cause;
  }
};
var fail = (code, message, cause) => new FlickerScopeError(code, message, cause);
var OPTION_DEFAULTS = { mode: "auto", seconds: 6, size: 256, ...DEFAULTS };
function createSampler(video, o, frames) {
  let ctx, w, h;
  const s = {
    frames,
    layout: null,
    add(t) {
      if (!ctx) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) throw fail("LOAD_FAILED", "The video has no picture yet.");
        const k = o.size / Math.max(vw, vh);
        const c = document.createElement("canvas");
        c.width = w = Math.max(1, Math.round(vw * k));
        c.height = h = Math.max(1, Math.round(vh * k));
        ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        s.layout = makeLayout(w, h, o.grid);
      }
      ctx.drawImage(video, 0, 0, w, h);
      let data;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch (e) {
        throw e && e.name === "SecurityError" ? fail("CROSS_ORIGIN", 0, e) : e;
      }
      frames.push({ t, ...measureFrame(data, s.layout, 4, o) });
    }
  };
  return s;
}
function eachFrame(video, fn) {
  const rvfc = !!video.requestVideoFrameCallback;
  let on = true, handle = 0, last = -1;
  const next = () => handle = rvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  const tick = (_, meta) => {
    if (!on) return;
    if (rvfc) fn(meta.mediaTime);
    else if (video.currentTime !== last) fn(last = video.currentTime);
    if (on) next();
  };
  next();
  return () => {
    on = false;
    rvfc ? video.cancelVideoFrameCallback && video.cancelVideoFrameCallback(handle) : cancelAnimationFrame(handle);
  };
}
function waitFor(video, events, ok, ms, kick) {
  return new Promise((resolve, reject) => {
    const off = () => {
      clearTimeout(timer);
      for (const e of events) video.removeEventListener(e, check);
      video.removeEventListener("error", bad);
    };
    const check = (e) => ok(e) && (off(), resolve());
    const bad = () => (off(), reject(fail("LOAD_FAILED")));
    const timer = setTimeout(() => (off(), reject(fail("LOAD_FAILED", MESSAGES.TIMEOUT))), ms);
    for (const e of events) video.addEventListener(e, check);
    video.addEventListener("error", bad);
    if (kick) kick();
    check();
  });
}
var waitReady = (video) => video.error ? Promise.reject(fail("LOAD_FAILED")) : waitFor(video, ["loadeddata", "canplay", "seeked"], () => video.readyState > 1, 3e4);
var seekTo = (video, time) => Math.abs(video.currentTime - time) < 1e-4 && !video.seeking ? waitReady(video) : waitFor(video, ["seeked"], (e) => !!e, 15e3, () => {
  video.currentTime = time;
}).then(() => waitReady(video));
var COMMON_FPS = [24, 25, 30, 50, 60, 120, 240];
async function estimateFps(video) {
  if (!video.requestVideoFrameCallback) return 0;
  try {
    await video.play();
  } catch {
    return 0;
  }
  const times = [];
  await new Promise((resolve) => {
    const timer = setTimeout(done, 1500);
    const stop = eachFrame(video, (t) => times.push(t) >= 16 && done());
    function done() {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
  video.pause();
  const d = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (d.length < 4) return 0;
  const fps = 1 / d.sort((a, b) => a - b)[d.length >> 1];
  return COMMON_FPS.find((c) => Math.abs(fps - c) / c < 0.03) || fps;
}
async function sampleSeek(video, sampler, o, own, progress) {
  video.muted = true;
  const fps = o.fps || await estimateFps(video) || 30;
  const dur = Number.isFinite(video.duration) ? video.duration : Infinity;
  let start = o.start ?? (own ? 0 : video.currentTime);
  if (start + o.seconds > dur) start = Math.max(0, dur - o.seconds);
  start = Math.floor(start * fps + 1e-6) / fps;
  const n = Math.max(1, Math.floor((Math.min(dur, start + o.seconds) - start) * fps + 1e-6));
  for (let i = 0; i < n; i++) {
    if (o.signal?.aborted) throw fail("ABORTED");
    const at = start + (i + 0.5) / fps;
    if (at >= dur) break;
    await seekTo(video, at);
    sampler.add(i / fps);
    progress((i + 1) / n);
  }
}
async function samplePlay(video, sampler, o, progress) {
  const dur = video.duration;
  if (o.start != null) await seekTo(video, o.start);
  else if (video.ended || video.currentTime + o.seconds > dur) await seekTo(video, Math.max(0, dur - o.seconds - 0.1));
  video.muted = true;
  video.playbackRate = 1;
  try {
    await video.play();
  } catch (e) {
    throw fail("PLAYBACK_BLOCKED", 0, e);
  }
  await new Promise((resolve, reject) => {
    let t0 = null, last = -Infinity;
    const finish = (e) => {
      clearTimeout(timer);
      stop();
      video.removeEventListener("ended", finish);
      video.pause();
      e instanceof Error ? reject(e) : resolve();
    };
    const timer = setTimeout(finish, (o.seconds * 3 + 10) * 1e3);
    video.addEventListener("ended", finish);
    const stop = eachFrame(video, (t) => {
      if (o.signal?.aborted) return finish(fail("ABORTED"));
      if (t <= last) return t < last - 0.5 && finish();
      if (t0 === null) t0 = t;
      last = t;
      try {
        sampler.add(t - t0);
      } catch (e) {
        return finish(e);
      }
      progress(Math.min(1, (t - t0) / o.seconds));
      if (t - t0 >= o.seconds) finish();
    });
  });
}
function resolveInput(input) {
  if (typeof HTMLVideoElement !== "undefined" && input instanceof HTMLVideoElement) return { video: input };
  let url, blob = typeof Blob !== "undefined" && input instanceof Blob;
  if (blob) url = URL.createObjectURL(input);
  else if (typeof input === "string" || input instanceof URL) url = String(input);
  else throw fail("BAD_INPUT");
  const v = document.createElement("video");
  if (!/^(blob|data):/i.test(url)) v.crossOrigin = "anonymous";
  v.muted = v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("aria-hidden", "true");
  v.preload = "auto";
  v.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;opacity:.01;pointer-events:none;z-index:-1";
  v.src = url;
  (document.body || document.documentElement).appendChild(v);
  return {
    video: v,
    own: true,
    dispose() {
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
      if (blob) URL.revokeObjectURL(url);
    }
  };
}
async function measure(input, options = {}) {
  const o = { ...OPTION_DEFAULTS, ...options };
  const progress = o.onProgress || (() => {
  });
  const { video, own, dispose } = resolveInput(input);
  const saved = !own && { time: video.currentTime, paused: video.paused, muted: video.muted, rate: video.playbackRate };
  const sampler = createSampler(video, o, []);
  try {
    if (video.mediaKeys) throw fail("PROTECTED");
    const mode = o.mode === "auto" ? own ? "seek" : "play" : o.mode;
    if (own || mode === "seek") await waitReady(video);
    if (o.signal?.aborted) throw fail("ABORTED");
    await (mode === "seek" ? sampleSeek(video, sampler, o, own, progress) : samplePlay(video, sampler, o, progress));
    if (sampler.frames.length < 4) throw fail("NO_FRAMES");
    return { ...analyze(sampler.frames, sampler.layout, o), mode };
  } finally {
    if (saved) {
      try {
        video.pause();
        video.playbackRate = saved.rate;
        if (Math.abs(video.currentTime - saved.time) > 1e-3) await seekTo(video, saved.time).catch(() => {
        });
        video.muted = saved.muted;
        if (!saved.paused) await video.play().catch(() => {
        });
      } catch {
      }
    }
    if (dispose) dispose();
  }
}
function watch(video, onUpdate, options = {}) {
  const o = { span: 3, interval: 0.5, ...OPTION_DEFAULTS, ...options };
  const frames = [];
  const sampler = createSampler(video, o, frames);
  const report = (e) => o.onError ? o.onError(e) : console.warn("FlickerScope: " + e.message);
  let last = -Infinity, lastEmit = -Infinity;
  if (video.mediaKeys) {
    report(fail("PROTECTED"));
    return () => {
    };
  }
  const stop = eachFrame(video, (t) => {
    if (t === last) return;
    if (t < last || t - last > 1) frames.length = 0;
    if (!frames.length) lastEmit = -Infinity;
    last = t;
    try {
      sampler.add(t);
    } catch (e) {
      stop();
      return report(e);
    }
    while (t - frames[0].t > o.span) frames.shift();
    if (frames.length > 7 && t - lastEmit >= o.interval) {
      lastEmit = t;
      onUpdate({ ...analyze(frames, sampler.layout, o), mode: "watch" });
    }
  });
  return stop;
}
var index_default = { measure, watch, analyze, FlickerScopeError, version };
export {
  DEFAULTS,
  FlickerScopeError,
  LABELS,
  SRGB_TO_LINEAR,
  analyze,
  index_default as default,
  detrend,
  dominantHz,
  findCuts,
  flickerIndex,
  frameRate,
  labelFor,
  makeLayout,
  measure,
  measureFrame,
  outliers,
  percentFlicker,
  percentile,
  periodogram,
  seriesFlicker,
  version,
  watch,
  weightedPercentile
};
