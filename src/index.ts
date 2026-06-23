export { captureStyleMap, saveStyleMap, loadStyleMap, trackInflightRequests } from './capture.js';
export type { StyleMap, CaptureOptions, ElementEntry, Rect } from './capture.js';
export { defineStyleMapCapture } from './runner.js';
export type { Surface, DefineOptions } from './runner.js';
export { diffStyleMaps, diffStyleMapDirs, diffContentMaps, diffContentDirs, findingLabel } from './diff.js';
export type { Finding, PropChange, SurfaceDiff, DiffCounts, ContentChange } from './diff.js';
export { generateStyleMapReport, summarizeProps, prettyLabel } from './report.js';
export type { ReportOptions, ReportResult } from './report.js';
