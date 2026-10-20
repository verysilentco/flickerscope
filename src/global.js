// Entry for the <script> build: exposes the API as the global `FlickerScope`.
// (Named imports and a plain object keep the minified file smaller than a namespace.)
// The script build carries the main API and the core math; the ES module and
// CommonJS builds export every helper.
import {
  measure, watch, analyze, FlickerScopeError, version,
  DEFAULTS, LABELS, makeLayout, measureFrame, detrend, percentFlicker, flickerIndex, labelFor,
} from './index.js';

const FlickerScope = {
  measure, watch, analyze, FlickerScopeError, version,
  DEFAULTS, LABELS, makeLayout, measureFrame, detrend, percentFlicker, flickerIndex, labelFor,
};
FlickerScope.default = FlickerScope;
(typeof globalThis !== 'undefined' ? globalThis : self).FlickerScope = FlickerScope;
