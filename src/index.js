// FlickerScope: measure flicker in a video, in the browser. Frames are drawn into a
// small canvas (longest side 256 px) and read with getImageData. No GPU compute, no
// upload: the pixels never leave the page.
import { DEFAULTS, makeLayout, measureFrame, analyze } from './math.js';

export * from './math.js';

/* global __VERSION__ */
export const version = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

const DROP = ' Download the clip and drop the file in instead.';
const MESSAGES = {
  CROSS_ORIGIN:
    "This website does not allow reading this video's pixels (no CORS permission, or DRM), so it cannot be measured in the browser." + DROP,
  PROTECTED: 'This video is DRM protected, so its pixels cannot be read.',
  LOAD_FAILED: 'The video could not be loaded. If it is on another website, that site may not allow reading it (CORS).' + DROP,
  NO_FRAMES: 'Too few frames could be read. In play mode the page must stay visible.',
  PLAYBACK_BLOCKED: 'The browser did not let the video play. Click the page and try again.',
  ABORTED: 'Cancelled.',
  TIMEOUT: 'The video stopped loading.',
  BAD_INPUT: 'Expected a video element, a File or Blob, or a URL.',
};

/** Error with a stable `code` and a plain-language `message`. */
export class FlickerScopeError extends Error {
  constructor(code, message, cause) {
    super(message || MESSAGES[code] || code);
    this.name = 'FlickerScopeError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}
const fail = (code, message, cause) => new FlickerScopeError(code, message, cause);

const OPTION_DEFAULTS = { mode: 'auto', seconds: 6, size: 256, ...DEFAULTS };

// ---------------------------------------------------------------- frame access

/** Draws video frames into a small canvas and measures them into `frames`.
 *  The canvas is created on first use, when the picture size is known. */
function createSampler(video, o, frames) {
  let ctx, w, h;
  const s = {
    frames,
    layout: null,
    add(t) {
      if (!ctx) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) throw fail('LOAD_FAILED', 'The video has no picture yet.');
        const k = o.size / Math.max(vw, vh);
        const c = document.createElement('canvas');
        c.width = w = Math.max(1, Math.round(vw * k));
        c.height = h = Math.max(1, Math.round(vh * k));
        ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        s.layout = makeLayout(w, h, o.grid);
      }
      ctx.drawImage(video, 0, 0, w, h);
      let data;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch (e) {
        throw e && e.name === 'SecurityError' ? fail('CROSS_ORIGIN', 0, e) : e;
      }
      frames.push({ t, ...measureFrame(data, s.layout, 4, o) });
    },
  };
  return s;
}

/** Calls fn(mediaTime) for every newly presented frame (requestVideoFrameCallback,
 *  else requestAnimationFrame watching currentTime). Returns a stop function. */
function eachFrame(video, fn) {
  const rvfc = !!video.requestVideoFrameCallback;
  let on = true, handle = 0, last = -1;
  const next = () => (handle = rvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick));
  const tick = (_, meta) => {
    if (!on) return;
    if (rvfc) fn(meta.mediaTime);
    else if (video.currentTime !== last) fn((last = video.currentTime));
    if (on) next();
  };
  next();
  return () => {
    on = false;
    rvfc ? video.cancelVideoFrameCallback && video.cancelVideoFrameCallback(handle) : cancelAnimationFrame(handle);
  };
}

/** Resolves once ok(event) holds after one of `events` (also checked right away
 *  with no event, after calling `kick`); rejects on a media error or after `ms`. */
function waitFor(video, events, ok, ms, kick) {
  return new Promise((resolve, reject) => {
    const off = () => {
      clearTimeout(timer);
      for (const e of events) video.removeEventListener(e, check);
      video.removeEventListener('error', bad);
    };
    const check = (e) => ok(e) && (off(), resolve());
    const bad = () => (off(), reject(fail('LOAD_FAILED')));
    const timer = setTimeout(() => (off(), reject(fail('LOAD_FAILED', MESSAGES.TIMEOUT))), ms);
    for (const e of events) video.addEventListener(e, check);
    video.addEventListener('error', bad);
    if (kick) kick();
    check();
  });
}

const waitReady = (video) =>
  video.error
    ? Promise.reject(fail('LOAD_FAILED'))
    : waitFor(video, ['loadeddata', 'canplay', 'seeked'], () => video.readyState > 1, 3e4);

const seekTo = (video, time) =>
  Math.abs(video.currentTime - time) < 1e-4 && !video.seeking
    ? waitReady(video)
    : waitFor(video, ['seeked'], (e) => !!e, 15e3, () => {
        video.currentTime = time;
      }).then(() => waitReady(video));

// 23.976, 29.97 and 59.94 snap to 24, 30 and 60: seeking at the round rate drifts
// under 0.2 frame over 6 s, and each target sits mid-frame.
const COMMON_FPS = [24, 25, 30, 50, 60, 120, 240];

/** Estimate the frame rate from presented frames during a short muted playback. */
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

/** Seek mode: step through the video frame by frame, waiting for each seek. */
async function sampleSeek(video, sampler, o, own, progress) {
  video.muted = true;
  const fps = o.fps || (await estimateFps(video)) || 30;
  const dur = Number.isFinite(video.duration) ? video.duration : Infinity;
  let start = o.start ?? (own ? 0 : video.currentTime);
  if (start + o.seconds > dur) start = Math.max(0, dur - o.seconds);
  start = Math.floor(start * fps + 1e-6) / fps;
  const n = Math.max(1, Math.floor((Math.min(dur, start + o.seconds) - start) * fps + 1e-6));
  for (let i = 0; i < n; i++) {
    if (o.signal?.aborted) throw fail('ABORTED');
    const at = start + (i + 0.5) / fps; // middle of frame i, away from frame boundaries
    if (at >= dur) break;
    await seekTo(video, at);
    sampler.add(i / fps);
    progress((i + 1) / n);
  }
}

/** Play mode: sample the frames the browser presents while the video plays muted. */
async function samplePlay(video, sampler, o, progress) {
  const dur = video.duration;
  if (o.start != null) await seekTo(video, o.start);
  else if (video.ended || video.currentTime + o.seconds > dur) await seekTo(video, Math.max(0, dur - o.seconds - 0.1));
  video.muted = true;
  video.playbackRate = 1;
  try {
    await video.play();
  } catch (e) {
    throw fail('PLAYBACK_BLOCKED', 0, e);
  }
  await new Promise((resolve, reject) => {
    let t0 = null, last = -Infinity;
    const finish = (e) => {
      clearTimeout(timer);
      stop();
      video.removeEventListener('ended', finish);
      video.pause();
      e instanceof Error ? reject(e) : resolve();
    };
    const timer = setTimeout(finish, (o.seconds * 3 + 10) * 1000);
    video.addEventListener('ended', finish);
    const stop = eachFrame(video, (t) => {
      if (o.signal?.aborted) return finish(fail('ABORTED'));
      if (t <= last) return t < last - 0.5 && finish(); // looped back: stop
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

// ---------------------------------------------------------------- inputs

function resolveInput(input) {
  if (typeof HTMLVideoElement !== 'undefined' && input instanceof HTMLVideoElement) return { video: input };
  let url, blob = typeof Blob !== 'undefined' && input instanceof Blob;
  if (blob) url = URL.createObjectURL(input);
  else if (typeof input === 'string' || input instanceof URL) url = String(input);
  else throw fail('BAD_INPUT');
  const v = document.createElement('video');
  if (!/^(blob|data):/i.test(url)) v.crossOrigin = 'anonymous';
  v.muted = v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('aria-hidden', 'true');
  v.preload = 'auto';
  // In the document so every browser decodes and presents frames, but not visible.
  v.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:.01;pointer-events:none;z-index:-1';
  v.src = url;
  (document.body || document.documentElement).appendChild(v);
  return {
    video: v,
    own: true,
    dispose() {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
      if (blob) URL.revokeObjectURL(url);
    },
  };
}

// ---------------------------------------------------------------- public API

/**
 * Measure flicker in a video.
 * @param {HTMLVideoElement|Blob|File|string|URL} input
 * @param {object} [options] see README / index.d.ts
 */
export async function measure(input, options = {}) {
  const o = { ...OPTION_DEFAULTS, ...options };
  const progress = o.onProgress || (() => {});
  const { video, own, dispose } = resolveInput(input);
  const saved = !own && { time: video.currentTime, paused: video.paused, muted: video.muted, rate: video.playbackRate };
  const sampler = createSampler(video, o, []);
  try {
    if (video.mediaKeys) throw fail('PROTECTED');
    const mode = o.mode === 'auto' ? (own ? 'seek' : 'play') : o.mode;
    if (own || mode === 'seek') await waitReady(video);
    if (o.signal?.aborted) throw fail('ABORTED');
    await (mode === 'seek' ? sampleSeek(video, sampler, o, own, progress) : samplePlay(video, sampler, o, progress));
    if (sampler.frames.length < 4) throw fail('NO_FRAMES');
    return { ...analyze(sampler.frames, sampler.layout, o), mode };
  } finally {
    if (saved) {
      // put a page's own video back the way it was
      try {
        video.pause();
        video.playbackRate = saved.rate;
        if (Math.abs(video.currentTime - saved.time) > 1e-3) await seekTo(video, saved.time).catch(() => {});
        video.muted = saved.muted;
        if (!saved.paused) await video.play().catch(() => {});
      } catch {
        /* best effort */
      }
    }
    if (dispose) dispose();
  }
}

/**
 * Live, rolling flicker readout while a video plays. Does not play, pause or seek
 * the video. Returns a function that stops watching.
 * @param {HTMLVideoElement} video
 * @param {(result: object) => void} onUpdate
 * @param {object} [options] span (s, default 3), interval (s, default 0.5), plus analysis options
 */
export function watch(video, onUpdate, options = {}) {
  const o = { span: 3, interval: 0.5, ...OPTION_DEFAULTS, ...options };
  const frames = [];
  const sampler = createSampler(video, o, frames);
  const report = (e) => (o.onError ? o.onError(e) : console.warn('FlickerScope: ' + e.message));
  let last = -Infinity, lastEmit = -Infinity;
  if (video.mediaKeys) {
    report(fail('PROTECTED'));
    return () => {};
  }
  const stop = eachFrame(video, (t) => {
    if (t === last) return;
    if (t < last || t - last > 1) frames.length = 0; // seeked or stalled: start a fresh window
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
      onUpdate({ ...analyze(frames, sampler.layout, o), mode: 'watch' });
    }
  });
  return stop;
}

export default { measure, watch, analyze, FlickerScopeError, version };
