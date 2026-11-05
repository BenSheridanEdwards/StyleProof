import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';

export const elementPath = (index) => `html > body > article:nth-child(${index}) > h2`;

export function render({
  count = 3,
  different = false,
  overlap = false,
  overlapCount = 0,
  states = false,
  restingChange = !states,
  screenshotHeight = 1200,
  maxCropFiles,
  maxCropBytes,
  maxReportBytes,
  maxJsonBytes,
  maxCrops = 30,
  heights,
  pathOf = elementPath,
  targetOf,
  rectangleOf,
  missingStateScreenshot,
} = {}) {
  const map = (after) =>
    makeMap({
      elements: Object.fromEntries(
        Array.from({ length: count }, (_, offset) => {
          const index = offset + 1;
          return [
            pathOf(index),
            {
              tag: 'h2',
              cls: 'card-title',
              rect: rectangleOf
                ? rectangleOf(index)
                : [20, overlap || index <= overlapCount ? 20 : index * 90, 180, 20],
              style: {
                ...(heights ? { height: `${after ? heights[offset] : 20}px` } : {}),
                color:
                  after && restingChange
                    ? different && index === 3
                      ? 'rgb(0, 128, 0)'
                      : 'rgb(150, 30, 60)'
                    : 'rgb(30, 60, 120)',
              },
            },
          ];
        }),
      ),
      states: states
        ? Object.fromEntries(
            Array.from({ length: count }, (_, offset) => {
              const owner = pathOf(offset + 1);
              const target = targetOf ? targetOf(owner, offset + 1) : owner;
              return [
                owner,
                {
                  hover: { [target]: { 'background-color': after ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 255)' } },
                  focus: { [owner]: { 'outline-width': after ? '3px' : '1px' } },
                },
              ];
            }),
          )
        : {},
    });
  const captureMap = (after) => {
    const result = map(after);
    if (targetOf)
      for (let index = 1; index <= count; index++) {
        const target = targetOf(pathOf(index), index);
        result.elements[target] = { tag: 'span', cls: '', rect: [20, index * 90, 20, 20], style: {} };
      }
    return result;
  };
  const dirs = pairFixture({
    surface: 'cards@390',
    before: captureMap(false),
    after: captureMap(true),
    beforePng: solidPng(390, screenshotHeight),
    afterPng: solidPng(390, screenshotHeight, [150, 30, 60]),
  });
  if (states)
    for (const directory of [dirs.beforeDir, dirs.afterDir])
      for (const state of ['hover', 'focus']) {
        if (state === missingStateScreenshot && directory === dirs.afterDir) continue;
        fs.writeFileSync(`${directory}/cards@390.${state}.png`, solidPng(390, 1200));
      }
  try {
    const result = generateStyleMapReport({
      ...dirs,
      maxCrops,
      maxCropFiles,
      maxCropBytes,
      maxReportBytes,
      maxJsonBytes,
    });
    return {
      md: fs.readFileSync(result.reportMdPath, 'utf8'),
      json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
    };
  } finally {
    rmTmp(dirs.root);
  }
}
