// Capture children opt in unless the caller explicitly supplied a value.
export function captureSourceMapsEnv(env = process.env) {
  return {
    ...env,
    ...(!Object.hasOwn(env, 'STYLEPROOF_CAPTURE_SOURCE_MAPS') ? { STYLEPROOF_CAPTURE_SOURCE_MAPS: '1' } : {}),
  };
}
