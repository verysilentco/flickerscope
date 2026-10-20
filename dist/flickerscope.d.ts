// Type definitions for flickerscope
// Project: https://github.com/verysilentco/flickerscope

export type Mode = 'auto' | 'play' | 'seek';
export type Label = 'none' | 'slight' | 'visible' | 'strong';
export type Warning = 'FEW_FRAMES' | 'TOO_DARK' | 'CLIPPED' | 'LOW_USABLE_AREA' | 'LOW_FRAME_RATE';
export type ErrorCode =
  | 'CROSS_ORIGIN'
  | 'PROTECTED'
  | 'LOAD_FAILED'
  | 'NO_FRAMES'
  | 'PLAYBACK_BLOCKED'
  | 'ABORTED'
  | 'BAD_INPUT';

/** Settings of the analysis itself (shared by measure, watch and analyze). */
export interface AnalysisOptions {
  /** Cells per side of the regional grid. Default 4 (16 cells). */
  grid?: number;
  /** Centered moving-average window for the trend, in seconds. Default 0.3. */
  trendWindow?: number;
  /** Upper percentile used as "max" for Percent Flicker. Default 95. */
  hiPercentile?: number;
  /** Lower percentile used as "min" for Percent Flicker. Default 5. */
  loPercentile?: number;
  /** Area-weighted percentile across cells for the regional value. Default 75. */
  cellPercentile?: number;
  /** Weight of the strongest sustained single-cell flicker in the headline. Default 0.5. */
  localWeight?: number;
  /** 8-bit sRGB code below which a pixel (its brightest channel) is near-black. Default 20. */
  darkCode?: number;
  /** 8-bit sRGB code at or above which a pixel (any channel) is clipped. Default 250. */
  clipCode?: number;
  /** Fraction of a cell's pixels that must carry signal for the cell to be used. Default 0.5. */
  minValid?: number;
}

export interface MeasureOptions extends AnalysisOptions {
  /**
   * 'play' samples presented frames while the video plays muted; 'seek' steps
   * frame by frame. 'auto' (default): 'seek' for File/Blob/URL inputs, 'play' for
   * a <video> element.
   */
  mode?: Mode;
  /** Seconds of video to analyze. Default 6. */
  seconds?: number;
  /** Where to start, in seconds. Default: 0 for files and URLs, the current time for elements. */
  start?: number;
  /** Seek mode step rate. Default: estimated from a short muted playback, else 30. */
  fps?: number;
  /** Longest side of the sampling canvas, in pixels. Default 64. */
  size?: number;
  /** Cancel the measurement. */
  signal?: AbortSignal;
  /** Progress from 0 to 1. */
  onProgress?: (fraction: number) => void;
}

export interface WatchOptions extends AnalysisOptions {
  /** Rolling window, in seconds. Default 3. */
  span?: number;
  /** Seconds of video between updates. Default 0.5. */
  interval?: number;
  /** Longest side of the sampling canvas, in pixels. Default 64. */
  size?: number;
  /** Called once if frames cannot be read (for example CROSS_ORIGIN); watching stops. */
  onError?: (error: FlickerScopeError) => void;
}

export interface Region {
  row: number;
  col: number;
  /** Position and size as fractions of the frame (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** False when the cell is mostly near-black or clipped; then the numbers are null. */
  usable: boolean;
  /** Mean linear-light luminance, 0..1. */
  brightness: number;
  /** Percent Flicker of this cell over the whole window. */
  percent: number | null;
  flickerIndex: number | null;
  /** The smaller of this cell's Percent Flicker in the first and second half of the window. */
  sustained: number | null;
}

export interface Result {
  /** Headline flicker %, 0..100: max(whole.percent, regional.percent, local.percent). */
  percent: number;
  /** IEEE 1789 Flicker Index, 0..1: max(whole, regional). */
  flickerIndex: number;
  /** Dominant visible (aliased) flicker rhythm in Hz, or null when there is no clear one. */
  hz: number | null;
  label: Label;
  /** Frames analyzed. */
  frames: number;
  /** Seconds of video analyzed. */
  seconds: number;
  /** Median sampled frame rate. */
  fps: number;
  /** Fraction of the frame with enough signal (not near-black, not clipped), 0..1. */
  usableArea: number;
  /** Present on measure() and watch() results. */
  mode?: 'play' | 'seek' | 'watch';
  whole: { percent: number; flickerIndex: number };
  /** Area-weighted 75th percentile across usable cells. */
  regional: { percent: number; flickerIndex: number };
  /** Half the strongest sustained cell flicker, and that cell's index in `regions`. */
  local: { percent: number; region: number | null };
  regions: Region[];
  series: {
    /** Seconds from the first analyzed frame. */
    t: number[];
    /** Whole-frame mean linear luminance (usable cells), 0..1. */
    brightness: number[];
    /** Its 0.3 s centered moving-average trend. */
    trend: number[];
  };
  warnings: Warning[];
}

export declare class FlickerScopeError extends Error {
  constructor(code: ErrorCode, message?: string, cause?: unknown);
  name: 'FlickerScopeError';
  code: ErrorCode;
  cause?: unknown;
}

/** Measure flicker in a video element, a File/Blob, or a (CORS-enabled) URL. */
export declare function measure(
  input: HTMLVideoElement | Blob | string | URL,
  options?: MeasureOptions,
): Promise<Result>;

/** Live rolling readout while a video plays. Returns a function that stops watching. */
export declare function watch(
  video: HTMLVideoElement,
  onUpdate: (result: Result) => void,
  options?: WatchOptions,
): () => void;

export declare const version: string;

// ------------------------------------------------------------------ pure math

export interface Layout {
  width: number;
  height: number;
  grid: number;
  cellOf: Uint16Array;
  area: Float64Array;
}
export interface MeasuredFrame {
  /** Seconds. */
  t: number;
  /** Mean linear luminance per cell. */
  cells: ArrayLike<number>;
  /** Fraction of usable pixels per cell. */
  valid: ArrayLike<number>;
}
type Bytes = ArrayLike<number>;

export declare const DEFAULTS: Required<AnalysisOptions>;
/** Label thresholds: [upper bound (exclusive), label]. */
export declare const LABELS: ReadonlyArray<readonly [number, Label]>;
export declare const SRGB_TO_LINEAR: Float64Array;
export declare function makeLayout(width: number, height: number, grid?: number): Layout;
export declare function measureFrame(
  data: Bytes,
  layout: Layout,
  channels?: 3 | 4,
  options?: Pick<AnalysisOptions, 'darkCode' | 'clipCode'>,
): { cells: Float64Array; valid: Float64Array };
export declare function analyze(frames: MeasuredFrame[], layout: Layout, options?: AnalysisOptions): Result;
export declare function detrend(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  window?: number,
): { trend: Float64Array; ratio: Float64Array; inner: Uint8Array };
export declare function findCuts(t: ArrayLike<number>, y: ArrayLike<number>, window?: number): number[];
export declare function percentFlicker(ratio: ArrayLike<number>, lo?: number, hi?: number): number;
export declare function flickerIndex(ratio: ArrayLike<number>, t?: ArrayLike<number>): number;
export declare function seriesFlicker(
  t: ArrayLike<number>,
  ratio: ArrayLike<number>,
  inner?: ArrayLike<number>,
  options?: AnalysisOptions,
): { percent: number; flickerIndex: number };
/** Groups are tried in order; each is a list of [residual (ratio - 1), weight] pairs. */
export declare function dominantHz(
  t: ArrayLike<number>,
  groups: Array<Array<[ArrayLike<number>, number]>>,
  minProminence?: number,
): number | null;
/** Flags frames far from the moving median (flashes) so the trend skips them. */
export declare function outliers(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  bounds: number[],
  halfWindow: number,
): boolean[];
export declare function periodogram(
  t: ArrayLike<number>,
  x: ArrayLike<number>,
  fmin: number,
  fmax: number,
  step: number,
): { f: number[]; p: number[] };
export declare function frameRate(t: ArrayLike<number>): number;
export declare function percentile(values: ArrayLike<number>, p: number): number;
export declare function weightedPercentile(values: number[], weights: ArrayLike<number>, p: number): number;
export declare function labelFor(percent: number): Label;

/** Default export of the ES module and CommonJS builds. The script build's global
 *  `FlickerScope` has these plus DEFAULTS, LABELS, makeLayout, measureFrame, detrend,
 *  percentFlicker, flickerIndex and labelFor. */
declare const FlickerScope: {
  measure: typeof measure;
  watch: typeof watch;
  analyze: typeof analyze;
  FlickerScopeError: typeof FlickerScopeError;
  version: string;
};
export default FlickerScope;
