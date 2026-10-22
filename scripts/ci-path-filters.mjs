import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The filter every browser and dogfood workflow passes to dorny/paths-filter. */
export const PATH_FILTERS_FILE = '.github/path-filters.yml';

/** Accept only the reviewed universal pattern; unsupported policy changes abort the local gate. */
export function validatePathFilters(
  text = fs.readFileSync(fileURLToPath(new URL(`../${PATH_FILTERS_FILE}`, import.meta.url)), 'utf8'),
) {
  // YAML treats both CR and LF as line breaks, including inside comments.
  // Ignore only ASCII whitespace/comments, not unsupported YAML control characters.
  const lines = text.split(/\r\n|\r|\n/).filter((line) => !/^[ \t]*(?:#[\t -~]*)?$/.test(line));
  if (lines.length !== 2 || lines[0] !== 'lanes:' || lines[1] !== "  - '([\\s\\S]+)'") {
    throw new Error(`${PATH_FILTERS_FILE} must be one 'lanes:' filter with only '([\\s\\S]+)'`);
  }
}

validatePathFilters();

/** Every changed Git filename runs browsers; only a proven empty inventory may skip. */
export function needsBrowserLanes(files) {
  if (!Array.isArray(files)) throw new Error('Changed paths must be an array');
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0) throw new Error('Changed paths must be nonempty filenames');
  }
  // Do not rewrite Git filenames: a literal backslash is not a path separator.
  return files.length > 0;
}
