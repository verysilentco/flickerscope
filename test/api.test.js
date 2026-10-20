// Integration tests for measure() and watch() with a scripted fake <video> and canvas,
// so the play, seek, restore and error paths run in Node. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A minimal stand-in for HTMLVideoElement: frames advance on a fast timer while
 *  playing, requestVideoFrameCallback fires per frame, seeks fire 'seeked'. */
class FakeVideo extends EventTarget {
  constructor({ fps = 30, duration = 10, depth = 0.08, rvfc = true } = {}) {
    super();
    Object.assign(this, { fps, duration, depth, videoWidth: 64, videoHeight: 36, readyState: 4 });
    Object.assign(this, { paused: true, muted: false, playbackRate: 1, seeking: false, ended: false });
    this.error = null;
    this.mediaKeys = null;
    this.tainted = false;
    this._t = 0;
    this._cbs = new Map();
    this._id = 0;
    if (!rvfc) this.requestVideoFrameCallback = undefined;
  }
  get currentTime() {
    return this._t;
  }
  set currentTime(v) {
    this._t = Math.max(0, Math.min(v, this.duration));
    this.ended = false;
    this.seeking = true;
    setTimeout(() => {
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    }, 0);
  }
  play() {
    if (this.paused) {
      this.paused = false;
      this._timer = setInterval(() => this._tick(), 1);
    }
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    clearInterval(this._timer);
  }
  requestVideoFrameCallback(cb) {
    this._cbs.set(++this._id, cb);
    return this._id;
  }
  cancelVideoFrameCallback(id) {
    this._cbs.delete(id);
  }
  _tick() {
    const next = this._t + 1 / this.fps;
    if (next >= this.duration) {
      this._t = this.duration;
      this.ended = true;
      this.pause();
      this.dispatchEvent(new Event('ended'));
      return;
    }
    this._t = next;
    const cbs = [...this._cbs.values()];
    this._cbs.clear();
    const mediaTime = Math.floor(this._t * this.fps + 1e-6) / this.fps;
    for (const cb of cbs) cb(0, { mediaTime });
  }
  /** RGBA pixels of the frame on show: gray code value 120 that alternates +-depth frame
   *  to frame (+-8 % in code values is about +-18 % in linear light: 110 / 130). */
  pixels(w, h) {
    const k = Math.floor(this._t * this.fps + 1e-6);
    const level = Math.round(120 * (1 + (k % 2 ? this.depth : -this.depth)));
    return new Uint8ClampedArray(w * h * 4).fill(level);
  }
}

globalThis.HTMLVideoElement = FakeVideo;
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    const ctx = {
      drawImage(v, x, y, w, h) {
        Object.assign(this, { v, w, h });
      },
      getImageData() {
        if (this.v.tainted) throw new DOMException('The canvas has been tainted', 'SecurityError');
        return { data: this.v.pixels(this.w, this.h) };
      },
    };
    return { getContext: () => ctx };
  },
};

const { measure, watch, FlickerScopeError, SRGB_TO_LINEAR } = await import('../src/index.js');

// Codes 110 / 130 alternate; a 9-frame centered average keeps 1/9 of an alternation
// in the trend at 30 fps, so the expected reading is 8/9 of the linear-light swing.
const lin = (c) => SRGB_TO_LINEAR[c];
const EXPECTED = ((100 * (lin(130) - lin(110))) / (lin(130) + lin(110))) * (8 / 9);

test('play mode samples presented frames and restores the element', async () => {
  const v = new FakeVideo();
  v._t = 1;
  v.muted = false;
  v.playbackRate = 1.5;
  const r = await measure(v, { seconds: 3 });
  assert.equal(r.mode, 'play');
  assert.ok(r.frames >= 85 && r.frames <= 95, `frames ${r.frames}`);
  assert.ok(Math.abs(r.percent - EXPECTED) < 1, `percent ${r.percent} vs ${EXPECTED}`);
  assert.ok(Math.abs(r.hz - 15) < 0.3, `hz ${r.hz}`);
  // put back as it was
  assert.ok(Math.abs(v.currentTime - 1) < 1e-9, `time ${v.currentTime}`);
  assert.equal(v.paused, true);
  assert.equal(v.muted, false);
  assert.equal(v.playbackRate, 1.5);
});

test('a playing element keeps playing afterwards', async () => {
  const v = new FakeVideo();
  await v.play();
  await measure(v, { seconds: 1 });
  assert.equal(v.paused, false);
  v.pause();
});

test('play mode near the end moves the window back to fit', async () => {
  const v = new FakeVideo({ duration: 4 });
  v._t = 3.5;
  const r = await measure(v, { seconds: 2 });
  assert.ok(r.frames >= 55, `frames ${r.frames}`);
});

test('play mode falls back to requestAnimationFrame without requestVideoFrameCallback', async () => {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 1);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const v = new FakeVideo({ rvfc: false });
  const r = await measure(v, { seconds: 1 });
  assert.ok(r.frames >= 10, `frames ${r.frames}`);
  assert.equal(r.label === 'none', false);
});

test('seek mode steps frame by frame', async () => {
  const v = new FakeVideo();
  const progress = [];
  const r = await measure(v, { mode: 'seek', fps: 30, seconds: 2, start: 0, onProgress: (p) => progress.push(p) });
  assert.equal(r.mode, 'seek');
  assert.equal(r.frames, 60);
  assert.ok(Math.abs(r.percent - EXPECTED) < 0.5, `percent ${r.percent} vs ${EXPECTED}`);
  assert.equal(progress.at(-1), 1);
});

test('seek mode estimates the frame rate when none is given', async () => {
  const v = new FakeVideo({ fps: 25 });
  const r = await measure(v, { mode: 'seek', seconds: 2, start: 0 });
  assert.equal(r.fps, 25);
  assert.equal(r.frames, 50);
});

test('unreadable pixels reject with CROSS_ORIGIN', async () => {
  const v = new FakeVideo();
  v.tainted = true;
  await assert.rejects(measure(v, { seconds: 1 }), (e) => e instanceof FlickerScopeError && e.code === 'CROSS_ORIGIN' && /CORS/.test(e.message));
  assert.equal(v.paused, true);
});

test('DRM-protected video rejects with PROTECTED', async () => {
  const v = new FakeVideo();
  v.mediaKeys = {};
  await assert.rejects(measure(v), { code: 'PROTECTED' });
});

test('abort signal rejects with ABORTED', async () => {
  const v = new FakeVideo();
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assert.rejects(measure(v, { mode: 'seek', fps: 30, signal: c.signal }), { code: 'ABORTED' });
});

test('bad input rejects with BAD_INPUT', async () => {
  await assert.rejects(measure(42), { code: 'BAD_INPUT' });
});

test('watch gives rolling updates and stops cleanly', async () => {
  const v = new FakeVideo();
  const updates = [];
  const stop = watch(v, (r) => updates.push(r), { span: 1, interval: 0.25 });
  await v.play();
  await new Promise((r) => setTimeout(r, 400));
  stop();
  const count = updates.length;
  await new Promise((r) => setTimeout(r, 50));
  v.pause();
  assert.ok(count >= 3, `updates ${count}`);
  assert.equal(updates.length, count, 'no updates after stop');
  const last = updates.at(-1);
  assert.equal(last.mode, 'watch');
  assert.ok(last.seconds <= 1.1, `seconds ${last.seconds}`);
  assert.ok(Math.abs(last.percent - EXPECTED) < 1.5, `percent ${last.percent} vs ${EXPECTED}`);
});

test('watch reports unreadable pixels once through onError', async () => {
  const v = new FakeVideo();
  v.tainted = true;
  const errors = [];
  watch(v, () => assert.fail('no updates expected'), { onError: (e) => errors.push(e.code) });
  await v.play();
  await new Promise((r) => setTimeout(r, 50));
  v.pause();
  assert.deepEqual(errors, ['CROSS_ORIGIN']);
});
