import { captureKeysIn } from '../capture.js';
import { classifyRuleReach } from '../rule-reach.js';
import { codeValue } from '../code-span.js';
import type { StyleMap } from '../capture/types.js';
import type { RenderCtx } from './shared.js';

function imageSources(map: StyleMap): [string, string][] {
  const sources: [string, string][] = [];
  for (const [path, element] of Object.entries(map.elements)) {
    const source = element.style['img currentSrc'];
    if (element.tag === 'img' && source !== undefined) sources.push([path, source]);
  }
  for (const states of Object.values(map.states))
    for (const targets of Object.values(states))
      for (const [path, properties] of Object.entries(targets)) {
        const source = properties['img currentSrc'];
        if (source !== undefined) sources.push([path, source]);
      }
  return sources;
}

function imageEvidenceLines(before: StyleMap, after: StyleMap, surface: string): string[] {
  const lines: string[] = [];
  const sources = [...imageSources(before), ...imageSources(after)];
  for (const [value, reason] of [
    ['', 'unloaded image'],
    ['(blob URL; not compared)', 'blob URL'],
  ]) {
    const images = new Set(sources.filter(([, source]) => source === value).map(([path]) => path));
    if (images.size)
      lines.push(
        `- ${codeValue(surface)}: img currentSrc not compared (${reason}) on ${images.size} captured image(s).`,
      );
  }
  return lines;
}

/** Evidence limits and raster advice are report-only: neither can change the verdict. */
export function visualChannelEvidenceLines(ctx: RenderCtx): string[] {
  const base = new Set(captureKeysIn(ctx.beforeDir));
  const lines: string[] = [];
  let legacy = 0;
  for (const surface of captureKeysIn(ctx.afterDir)
    .filter((key) => base.has(key))
    .sort()) {
    const before = ctx.load(ctx.beforeDir, surface);
    const after = ctx.load(ctx.afterDir, surface);
    const beforeEnabled = before.visualChannels?.version === 1;
    const afterEnabled = after.visualChannels?.version === 1;
    if (beforeEnabled !== afterEnabled) {
      legacy++;
    } else if (beforeEnabled && afterEnabled) {
      const unknown = [
        ...new Set(
          [before, after].flatMap((map) =>
            Object.values(map.visualChannels!.keyframes)
              .filter((body) => body.status === 'unknown')
              .map((body) => body.name),
          ),
        ),
      ].sort();
      for (const name of unknown)
        lines.push(
          `- ${codeValue(surface)}: animation keyframes ${codeValue(name)} unknown; not compared (unreadable, missing or unsupported stylesheet scope).`,
        );
      for (const line of imageEvidenceLines(before, after, surface)) lines.push(line);
    }
    const fonts = classifyRuleReach([before], [after]).rules.filter(
      (rule) => /(?:^| > )@font-face(?: #\d+)?$/.test(rule.key) && rule.status === 'blind-channel',
    );
    if (fonts.length)
      lines.push(
        `- ${codeValue(surface)}: a changed \`@font-face\` is referenced by a matched rule; run \`--pixels\` for this surface to inspect glyph changes (recommendation only).`,
      );
  }
  if (legacy)
    lines.unshift(
      `- Keyframes/currentSrc not compared (map predates keyframes/currentSrc capture) on ${legacy} paired capture(s); recapture both sides with \`captureVisualChannels: true\`.`,
    );
  return lines.length ? ['', '**Visual channel evidence limits and recommendations**', '', ...lines, ''] : [];
}
