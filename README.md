# FlickerScope

Measure flicker in any video, in the browser: a flicker % from LED and fluorescent lights, no upload.

```js
import { measure } from 'flickerscope';

const result = await measure(file); // a File from <input type="file"> or a drop
console.log(result.percent, result.label); // 8.2 'visible'
```

FlickerScope reads small copies of a video's frames in the page, tracks how the brightness
moves from frame to frame, and turns that into one number: how much the picture flickers.
The video never leaves the device. It has no dependencies, uses no GPU compute, and the
script build is about 6 KB gzipped.

Demo: [verysilentco.github.io/flickerscope](https://verysilentco.github.io/flickerscope/)
(the page in [`docs/`](docs/index.html)): drop in a clip and see its flicker % and a brightness chart.

This is a lightweight meter. It is not the full FlickerScope research method that
[Deflicker](https://deflickerapp.com) uses to measure its own results, which works per pixel
and follows motion. This one works on 16 regions of the frame, which is enough to tell a
clean clip from a flickering one in a fraction of a second per frame.

## What it measures

Lights powered from the mains (LED, fluorescent, some sodium and metal halide lamps) pulse
100 or 120 times a second. A camera samples that pulsing at its frame rate, and the result
is brightness that wobbles from frame to frame. FlickerScope:

1. reads the brightness of the whole frame and of a 4 x 4 grid of regions, in linear light;
2. removes slow changes (camera moves, fades, cuts, auto exposure) with a 0.3 s moving average;
3. measures what is left with the IEEE 1789 Percent Flicker and Flicker Index;
4. reports a headline flicker %, a plain label, and the rhythm of the flicker in Hz.

## Install

With a script tag, which defines a global `FlickerScope` (served by jsDelivr from this repository):

```html
<script src="https://cdn.jsdelivr.net/gh/verysilentco/flickerscope@1/dist/flickerscope.min.js"></script>
```

As an ES module:

```js
import { measure, watch } from 'https://cdn.jsdelivr.net/gh/verysilentco/flickerscope@1/dist/flickerscope.mjs';
```

Or download `dist/` from the [latest release](https://github.com/verysilentco/flickerscope/releases/latest)
and host it yourself.

The release ships `dist/flickerscope.mjs` (ES module), `dist/flickerscope.cjs` (CommonJS),
`dist/flickerscope.min.js` (script tag) and TypeScript declarations.

## Examples

A file the user picks or drops:

```js
input.addEventListener('change', async () => {
  const r = await FlickerScope.measure(input.files[0]);
  output.textContent = `${r.percent} % flicker (${r.label})`;
});
```

A video already on the page (it plays muted for a few seconds, then everything is put back:
time, paused or playing, muted, playback rate):

```js
const r = await FlickerScope.measure(document.querySelector('video'), { seconds: 4 });
```

A URL (the server must allow cross-origin reading, see [Limits](#limits)):

```js
const r = await FlickerScope.measure('https://example.com/clip.mp4');
```

A live readout while a video plays:

```js
const stop = FlickerScope.watch(video, (r) => {
  meter.textContent = `${r.percent} %`;
});
// later
stop();
```

Errors have a `code` and a plain `message` you can show as is:

```js
try {
  await FlickerScope.measure(url);
} catch (e) {
  if (e.code === 'CROSS_ORIGIN') showDropZone();
  alert(e.message);
}
```

## API

### `measure(input, options?) => Promise<Result>`

`input` is an `HTMLVideoElement`, a `File` or `Blob`, or a URL string. For a File or Blob,
FlickerScope makes its own hidden video element from an object URL and removes it afterwards.
For a URL it does the same with `crossOrigin = "anonymous"`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `'auto'` | `'seek'` steps through the video frame by frame and waits for each seek: exact and repeatable. `'play'` plays the video muted and samples the frames the browser presents (with `requestVideoFrameCallback`, or `requestAnimationFrame` and `currentTime` where that is missing): faster, but limited to what the screen shows. `'auto'` uses `'seek'` for files and URLs and `'play'` for a video element. |
| `seconds` | `6` | How much video to measure. |
| `start` | `0` for files and URLs, the current time for an element | Where to start, in seconds. If fewer than `seconds` remain, the window moves back to fit. |
| `fps` | estimated | Seek mode step rate. Estimated from presented frames during a short muted playback, else 30. |
| `size` | `256` | Longest side of the sampling canvas, in pixels. |
| `signal` | none | An `AbortSignal` to cancel. |
| `onProgress` | none | Called with a number from 0 to 1. |
| `grid` | `4` | Regions per side (4 means 16 regions). |
| `trendWindow` | `0.3` | Seconds of the centered moving average that defines "slow change". |
| `hiPercentile`, `loPercentile` | `95`, `5` | Percentiles used as the high and low of Percent Flicker. |
| `cellPercentile` | `75` | Area-weighted percentile across regions for the regional value. |
| `localWeight` | `0.5` | Weight of the strongest steady single region in the headline. |
| `darkCode`, `clipCode` | `20`, `250` | 8-bit levels below which a pixel counts as near-black, and at or above which it counts as clipped. |
| `minValid` | `0.5` | Share of a region's pixels that must be usable for the region to count. |

### `watch(video, onUpdate, options?) => stop`

Samples the frames the video presents while it plays and calls `onUpdate(result)` with a
measurement of the last `span` seconds. It never plays, pauses or seeks the video itself.
Seeking or a stall starts a fresh window.

| Option | Default | Meaning |
| --- | --- | --- |
| `span` | `3` | Seconds in the rolling window. |
| `interval` | `0.5` | Seconds of video between updates. |
| `onError` | `console.warn` | Called once if frames cannot be read; watching stops. |
| `size` and the analysis options | as above | |

### Result

| Field | Meaning |
| --- | --- |
| `percent` | Headline flicker %, 0 to 100 (definition below). |
| `label` | `'none'`, `'slight'`, `'visible'` or `'strong'`. |
| `flickerIndex` | IEEE 1789 Flicker Index, 0 to 1: the larger of the whole-frame and regional values. |
| `hz` | The visible flicker rhythm in Hz, or `null` when there is no clear one or no flicker. |
| `frames`, `seconds`, `fps` | What was analyzed. `fps` is the median rate of the sampled frames. |
| `usableArea` | Share of the frame that was measured (0 to 1); near-black and blown-out regions are skipped. |
| `mode` | `'seek'`, `'play'` or `'watch'`. |
| `whole` | `{ percent, flickerIndex }` of the whole-frame brightness. |
| `regional` | `{ percent, flickerIndex }`: area-weighted 75th percentile across regions. |
| `local` | `{ percent, region }`: half the strongest steady single-region value, and that region's index. |
| `regions` | 16 entries: `{ row, col, x, y, w, h, usable, brightness, percent, flickerIndex, sustained }`. |
| `series` | `{ t, brightness, trend }`: seconds, whole-frame linear brightness (0 to 1) and its moving average, per frame. |
| `warnings` | Any of `FEW_FRAMES`, `TOO_DARK`, `CLIPPED`, `LOW_USABLE_AREA`, `LOW_FRAME_RATE`. |

### Errors

`measure` rejects with a `FlickerScopeError` (`name`, `code`, `message`, and `cause` when there is one):

| Code | When |
| --- | --- |
| `CROSS_ORIGIN` | The browser will not let the page read this video's pixels (another site without CORS permission, or DRM). |
| `PROTECTED` | The video uses DRM (Encrypted Media Extensions). |
| `LOAD_FAILED` | The video did not load or stopped loading. For a URL on another site this usually means the server does not allow cross-origin reading. |
| `NO_FRAMES` | Fewer than 4 frames could be read. |
| `PLAYBACK_BLOCKED` | Play mode, and the browser refused to play the video. |
| `ABORTED` | The `signal` was aborted. |
| `BAD_INPUT` | The input is not a video element, File, Blob or URL. |

### The math, on its own

The analysis is a set of pure functions with no DOM, exported from the same module, so it
runs in Node or a worker on frames you decode yourself (for example with ffmpeg):

```js
import { makeLayout, measureFrame, analyze } from 'flickerscope';

const layout = makeLayout(width, height); // 4 x 4 grid
const frames = rgbFrames.map((rgb, i) => ({ t: times[i], ...measureFrame(rgb, layout, 3) }));
const result = analyze(frames, layout);
```

`scripts/validate-real.mjs` in the repository does exactly this with ffmpeg.
Also exported: `detrend`, `findCuts`, `outliers`, `percentFlicker`, `flickerIndex`, `seriesFlicker`,
`dominantHz`, `periodogram`, `frameRate`, `percentile`, `weightedPercentile`, `labelFor`,
`DEFAULTS`, `LABELS`, `SRGB_TO_LINEAR`. The script-tag global `FlickerScope` carries `measure`,
`watch`, `analyze`, `FlickerScopeError`, `version`, `DEFAULTS`, `LABELS`, `makeLayout`,
`measureFrame`, `detrend`, `percentFlicker`, `flickerIndex` and `labelFor`.

## How the flicker % is defined

For each frame:

1. Draw the frame into a canvas whose longest side is 256 px and read the pixels.
2. Convert each pixel from sRGB to linear light and take its luminance,
   `Y = 0.2126 R + 0.7152 G + 0.0722 B`.
3. Average `Y` over each of the 16 regions (4 x 4 grid).
4. Mark each pixel usable if its brightest channel is at least 20 (not near-black) and no
   channel is 250 or more (not clipped). A region counts if, on average over time, at least
   half its pixels are usable. `usableArea` is the share of the frame in regions that count.

Over time, for the whole frame (the area-weighted mean of the regions that count) and for each region:

5. **Trend.** A centered moving average over 0.3 s, using the real frame timestamps. It is
   computed as a local straight-line fit over the window, which equals the plain moving
   average when the window is symmetric and stays unbiased on ramps at the ends of the clip
   and around dropped frames. A hard cut (a jump of more than about 20 % that stays) splits the
   series, and each side is detrended on its own. A flash (a camera flash, a muzzle flash, lightning)
   is left out of the average so it does not drag its neighbours with it: a frame counts as a flash
   when it is more than 15 % and more than 6 robust spreads (MAD) away from the median of its
   neighbours, and only while such frames are rare (at most 10 % of the frames; more than that is
   flicker). The flash frame keeps its own ratio, and the robust percentiles below ignore it.
6. **Ratio.** `r = L / trend`. Slow changes divide out; flicker remains.
7. **Percent Flicker** (IEEE 1789), with robust percentiles in place of the raw max and min:
   `PF = 100 x (P95(r) - P5(r)) / (P95(r) + P5(r))`. Frames whose 0.3 s window is cut off by
   the start or end of the clip are left out when enough frames remain.
8. **Flicker Index** (IEEE 1789): the area of `r` above its mean, divided by the total area,
   with each frame weighted by its duration.

Then the headline:

```
percent = max( whole,      PF of the whole-frame brightness
               regional,   area-weighted 75th percentile of the regions' PF
               local )     0.5 x the strongest "sustained" region PF
```

- `whole` catches flicker that moves the whole picture.
- `regional` catches flicker that covers a good part of the frame but is weak or cancels out in
  the frame average (for example rolling bands, where one part of the frame is bright while
  another is dark).
- `local` catches one flickering lamp or sign. A region's sustained PF is the smaller of its PF in
  the first half and in the second half of the window, so a person walking through one region
  for a moment does not count; it is weighted by half because it covers a small part of the picture.

`flickerIndex` is `max(whole, regional)` of the Flicker Index.

### Labels

| `percent` | `label` | |
| --- | --- | --- |
| under 2 | `none` | Compression noise and small motion live here. |
| 2 to under 5 | `slight` | Noticeable on a steady shot if you look for it. |
| 5 to under 12 | `visible` | Plainly visible. |
| 12 and over | `strong` | Hard to watch. |

These thresholds were set from real clips before and after deflickering (see Validation).

### Rhythm (`hz`)

The dominant frequency of the whole-frame ratio (a periodogram at the real timestamps, with a
Hann taper). When the regions lead the headline, their spectra are summed instead, so rolling
bands that cancel in the frame average still give a rhythm. A peak must stand at least 8 times
above the average of the band, otherwise `hz` is `null`.

This is the rhythm as the camera recorded it, not the frequency of the light. The frame rate
folds the light's frequency down: a 100 Hz light filmed at 30 fps shows up at 10 Hz
(100 - 3 x 30), and filmed at 60 fps at 20 Hz. A 120 Hz light filmed at exactly 30 or 60 fps
folds to 0 Hz, which means no flicker over time (it may still show as bands that stand still).

## Limits

- **Not every video on every website.** A page can only read a video's pixels when the video
  comes from the same site, or from a server that allows cross-origin reading (CORS), and is not
  DRM protected. YouTube, Netflix, Instagram, TikTok and most streaming services do not allow it,
  so FlickerScope rejects with `CROSS_ORIGIN`, `PROTECTED` or `LOAD_FAILED` and a message that says
  so. Local files, your own site's videos and CORS-enabled URLs always work. To measure a clip from
  elsewhere, download it and drop the file in.
- **Play mode sees what the screen shows.** It samples presented frames, so a 120 fps video on a
  60 Hz screen is sampled at 60 fps, and a busy page can drop frames (timestamps keep the math
  right, but fast flicker can alias). Without `requestVideoFrameCallback` it falls back to
  `requestAnimationFrame` and `currentTime`, which is coarser. Seek mode avoids all of this but is
  slower: each seek can take from a few to over 100 ms depending on how far apart the keyframes are.
- **Compression.** Video codecs add noise of their own, worth about 0.5 to 2 % on a steady shot,
  and heavy compression can smooth weak flicker away.
- **Motion.** Fast motion inside the frame (a person close to the lens, a waving flag) can read as a
  few percent. Camera moves and slow changes are removed by the moving average.
- **Slow pulsing.** Rhythms slower than about 2 to 3 Hz are treated as scene change. Above that, the
  0.3 s moving average passes the flicker with a ripple of up to about 20 %: frame-to-frame
  alternation reads about 11 % low at 30 fps, and rhythms near 5 and 12 Hz read slightly high.
- **Brightness only.** Color flicker that keeps brightness steady is not measured.
- **Dark and blown-out areas.** They carry too little signal and are skipped; `usableArea` says how
  much was measured, and `warnings` says when it was too little.

## Validation

`npm test` runs 31 tests with Node's built-in test runner.

The math, on synthetic signals: steady light reads about 0 %; a 100 Hz light filmed at 30 fps
reads strong with a 10 Hz rhythm; frame-to-frame alternation is caught at half the frame rate;
slow ramps, fades, auto exposure swings and hard cuts do not read as flicker; a two-frame camera
flash does not smear into its neighbours; motion through one region for part of the clip does not
count; flicker in a single region is still detected; rolling bands that cancel in the frame average
are not averaged away; dropped frames keep the rhythm right; and the IEEE 1789 formulas match their
textbook values.

The browser side, with a scripted stand-in for the video element and canvas: play mode samples
presented frames and puts the element back as it was (time, paused, muted, rate); seek mode steps
frame by frame and estimates the frame rate; the `requestAnimationFrame` fallback works; `watch`
updates and stops; unreadable pixels, DRM, cancelling and bad input give the right error codes.

On real iPhone footage (first 6 s, decoded with ffmpeg at 256 px and run through the same math in
Node with `npm run validate -- <files>`; the clips are not included in this repository):

| Clip | Before | After Deflicker | Rhythm (before) |
| --- | --- | --- | --- |
| Night golf range, 30 fps | 8.2 % (visible) | 2.9 % (slight) | 15 Hz |
| Indoor shooting range, 60 fps, with a muzzle flash | 48.0 % (strong) | 0.8 % (none) | 25 Hz |

The same four clips measured in Chromium with `measure(url)` in seek mode read 7.9 % and 3.0 % (golf range),
and 47.8 % and 0.8 % (shooting range). A synthetic test pattern with 10 Hz flicker (`docs/sample-flicker.mp4`)
reads 9.2 % in both.

## Bookmarklet

To measure the largest video on any page, make a bookmark with this as its address (or drag
the "Measure flicker" link from the demo page to your bookmarks bar):

```
javascript:(function(){function go(){var v=[].slice.call(document.querySelectorAll('video')).sort(function(a,b){var p=a.getBoundingClientRect(),q=b.getBoundingClientRect();return q.width*q.height-p.width*p.height})[0];if(!v){alert('No video found on this page.');return}FlickerScope.measure(v,{seconds:4}).then(function(r){alert('Flicker: '+r.percent+' % ('+r.label+')'+(r.hz?', rhythm '+r.hz+' Hz':'')+'\nTo remove it on iPhone: deflickerapp.com')},function(e){alert(e.message)})}if(window.FlickerScope)return go();var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/verysilentco/flickerscope@1/dist/flickerscope.min.js';s.onload=go;s.onerror=function(){alert('This page does not allow outside scripts, so FlickerScope cannot run here.')};document.head.appendChild(s)})();
```

It loads the script from jsDelivr, plays the video muted for 4 seconds, puts it back, and shows
the result. On sites that block outside scripts or protect their video (most streaming services)
it says so instead.

## Remove the flicker

FlickerScope only measures. To remove flicker from your own clips, [Deflicker](https://deflickerapp.com)
for iPhone fixes it on the phone.

## License

MIT. Copyright (c) 2026 Silent Co, LLC. Questions: contact@silent.co.
