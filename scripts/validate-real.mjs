// Run the FlickerScope math on real video files in Node, using ffmpeg to decode
// small RGB frames (longest side 256 px, like the browser sampler) with their real
// timestamps. Nothing is copied or written: frames are piped straight from ffmpeg.
//
//   node scripts/validate-real.mjs [--seconds 6] [--start 0] [--ffmpeg path] file1 [file2 ...]
//
// ffmpeg: --ffmpeg, else $FFMPEG, else the binary shipped with Python's imageio_ffmpeg,
// else "ffmpeg" on PATH.
import { spawn, execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { makeLayout, measureFrame, analyze } from '../src/math.js';

const args = process.argv.slice(2);
const opt = { seconds: 6, start: 0, size: 256, ffmpeg: process.env.FFMPEG || '' };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--seconds') opt.seconds = Number(args[++i]);
  else if (a === '--start') opt.start = Number(args[++i]);
  else if (a === '--size') opt.size = Number(args[++i]);
  else if (a === '--ffmpeg') opt.ffmpeg = args[++i];
  else if (a === '--json') opt.json = true;
  else files.push(a);
}
if (!files.length) {
  console.error('usage: node scripts/validate-real.mjs [--seconds 6|0=all] [--start s] file ...');
  process.exit(2);
}
if (!opt.ffmpeg) {
  try {
    opt.ffmpeg = execFileSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
  } catch {
    opt.ffmpeg = 'ffmpeg';
  }
}

function decode(file) {
  const L = opt.size;
  const vf = `scale=w='if(gt(iw,ih),${L},-2)':h='if(gt(iw,ih),-2,${L})':flags=area,showinfo`;
  const a = ['-hide_banner', '-nostdin'];
  if (opt.start) a.push('-ss', String(opt.start));
  a.push('-i', file);
  if (opt.seconds > 0) a.push('-t', String(opt.seconds));
  a.push('-an', '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  return new Promise((resolve, reject) => {
    const p = spawn(opt.ffmpeg, a);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}\n${err.slice(-2000)}`));
      const times = [...err.matchAll(/pts_time:\s*([-\d.e]+)/g)].map((m) => Number(m[1]));
      const size = err.match(/showinfo.*?\bs:(\d+)x(\d+)/);
      if (!size) return reject(new Error('could not read frame size from ffmpeg output'));
      resolve({ buf: Buffer.concat(out), w: Number(size[1]), h: Number(size[2]), times });
    });
  });
}

const rows = [];
for (const file of files) {
  const { buf, w, h, times } = await decode(file);
  const layout = makeLayout(w, h, 4);
  const frameBytes = w * h * 3;
  const count = Math.floor(buf.length / frameBytes);
  const frames = [];
  for (let k = 0; k < count; k++) {
    const m = measureFrame(buf.subarray(k * frameBytes, (k + 1) * frameBytes), layout, 3);
    frames.push({ t: times[k] ?? k / 30, cells: m.cells, valid: m.valid });
  }
  const r = analyze(frames, layout);
  rows.push({ file: basename(file), w, h, ...r });
}

if (opt.json) {
  console.log(JSON.stringify(rows.map(({ series, regions, ...r }) => r), null, 2));
} else {
  for (const r of rows) {
    console.log(
      `${r.file.padEnd(34)} ${String(r.w + 'x' + r.h).padEnd(7)} frames ${String(r.frames).padStart(4)}` +
        `  ${r.seconds.toFixed(2)} s  ${r.fps} fps  flicker ${String(r.percent).padStart(5)} % (${r.label})` +
        `  whole ${r.whole.percent} %  regional ${r.regional.percent} %  local ${r.local.percent} %  FI ${r.flickerIndex}` +
        `  rhythm ${r.hz ?? '-'} Hz  usable ${Math.round(r.usableArea * 100)} %` +
        (r.warnings.length ? `  [${r.warnings.join(', ')}]` : ''),
    );
  }
}
