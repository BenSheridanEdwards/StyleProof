export { captureStyleMap, saveStyleMap, loadStyleMap } from './capture.js';
export type { StyleMap, CaptureOptions, ElementEntry, Rect } from './capture.js';
export { defineStyleMapCapture } from './runner.js';
export type { Surface, DefineOptions } from './runner.js';
export { diffStyleMaps, diffStyleMapDirs, findingLabel } from './diff.js';
export type { Finding, PropChange, SurfaceDiff, DiffCounts } from './diff.js';
export { generateStyleMapReport } from './report.js';
export type { ReportOptions, ReportResult } from './report.js';
