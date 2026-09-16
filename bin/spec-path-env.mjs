// The spec path travels from styleproof-init into the generated hook/workflow as
// canonical base64, so a path with spaces or unicode survives shell quoting.
export const SPEC_PATH_ENV = 'STYLEPROOF_SPEC_PATH_B64';
export const PLAYWRIGHT_CONFIG_PATH = 'playwright.styleproof.config.ts';
const MAX_SPEC_PATH_BYTES = 4096;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeSpecPath(specPath) {
  return Buffer.from(specPath, 'utf8').toString('base64');
}

export function decodeSpecPathEnv(env = process.env) {
  const encoded = env[SPEC_PATH_ENV];
  if (encoded === undefined || encoded === '') return undefined;
  if (!BASE64.test(encoded)) throw new Error(`${SPEC_PATH_ENV} is not valid base64`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error(`${SPEC_PATH_ENV} is not canonical base64`);
  const decoded = bytes.toString('utf8');
  if (!decoded || !Buffer.from(decoded, 'utf8').equals(bytes)) {
    throw new Error(`${SPEC_PATH_ENV} is not valid UTF-8 path data`);
  }
  return decoded;
}

const hasControlCharacter = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

/** Normalise to forward slashes and refuse anything that could escape the repository. */
export function validateRepoRelativeSpecPath(specPath) {
  if (typeof specPath !== 'string') throw new Error('spec path must be a string');
  if (Buffer.byteLength(specPath, 'utf8') > MAX_SPEC_PATH_BYTES) {
    throw new Error(`spec path must not exceed ${MAX_SPEC_PATH_BYTES} UTF-8 bytes`);
  }
  if (hasControlCharacter(specPath)) throw new Error('spec path must not contain control characters');
  const normalized = specPath.replaceAll('\\', '/');
  if (/^(?:\/|[A-Za-z]:)/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error('spec path must stay inside the repository');
  }
  if (!normalized || normalized === '.') throw new Error('spec path requires a file path');
  return normalized;
}

/** True when the base ref lacks the spec or its Playwright config (first adoption). */
export function harnessMissingAtRef(specPath, consumerRelativePath, existsAtRef) {
  const prefix = consumerRelativePath && consumerRelativePath !== '.' ? consumerRelativePath : '';
  return [specPath, PLAYWRIGHT_CONFIG_PATH].some((file) => {
    const repositoryPath = prefix ? `${prefix.replaceAll('\\', '/')}/${file}` : file;
    return !existsAtRef(repositoryPath);
  });
}
