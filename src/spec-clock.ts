// The spec-process half of `freezeClock`: a capture spec's module-level fixture
// (`new Date().toISOString()`) runs in Node before any test, outside the browser
// freeze, and differs between the base and head runs — a phantom diff the in-run
// self-check cannot see. `styleproof-map` sets STYLEPROOF_FREEZE_SPEC_CLOCK=1 so that
// importing this module (via `styleproof`) swaps `globalThis.Date` for a frozen twin
// before the spec's own constants evaluate. StyleProof's own elapsed-time bookkeeping
// reads `realNow()`, captured before the swap.

/** The default frozen instant, shared with the browser-side freeze (`DefineOptions.clockTime`). */
export const DEFAULT_CLOCK_TIME = '2025-01-01T00:00:00Z';

const RealDate = globalThis.Date;

/** Wall-clock milliseconds from the real clock, immune to the spec-clock freeze. */
export function realNow(): number {
  return RealDate.now();
}

let installedInstant: number | undefined;

/**
 * `undefined` unless `STYLEPROOF_FREEZE_SPEC_CLOCK=1`; the instant comes from
 * `STYLEPROOF_CLOCK_TIME` (ISO or epoch ms), defaulting to `DEFAULT_CLOCK_TIME`.
 * An unparseable instant throws rather than silently running on the live clock.
 */
export function resolveSpecClockFreeze(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.STYLEPROOF_FREEZE_SPEC_CLOCK !== '1') return undefined;
  // `||`, not `??`: an EMPTY value (an unset workflow variable) means "default".
  const configured = env.STYLEPROOF_CLOCK_TIME || DEFAULT_CLOCK_TIME;
  const instant = /^-?\d+$/.test(configured) ? Number(configured) : RealDate.parse(configured);
  if (Number.isNaN(instant)) {
    throw new Error(
      `styleproof: STYLEPROOF_CLOCK_TIME is not a date: ${JSON.stringify(configured)} — ` +
        `pass an ISO instant (like ${DEFAULT_CLOCK_TIME}) or epoch milliseconds.`,
    );
  }
  return instant;
}

/**
 * Swap `globalThis.Date` for a pinned Proxy twin (parse/UTC/prototype/instanceof keep
 * working). Zero-argument `new Date()` and bare `Date()` report exactly the frozen
 * instant, while `Date.now()` advances monotonically FROM that instant — a `now()` that
 * never moves would turn every deadline loop (consumer helpers, Playwright's own retries)
 * into an infinite spin.
 */
export function installFrozenSpecClock(fixedMilliseconds: number): void {
  const installedAtReal = RealDate.now();
  const pinnedNow = () => fixedMilliseconds + Math.max(0, RealDate.now() - installedAtReal);
  const frozen = new Proxy(RealDate, {
    construct(target, argumentsList: unknown[], newTarget) {
      const effective = argumentsList.length === 0 ? [fixedMilliseconds] : argumentsList;
      return Reflect.construct(target, effective, newTarget) as object;
    },
    apply() {
      return new RealDate(fixedMilliseconds).toString();
    },
    get(target, property, receiver) {
      if (property === 'now') return pinnedNow;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  globalThis.Date = frozen as DateConstructor;
  installedInstant = fixedMilliseconds;
}

/** Put the real `Date` back (the `freezeClock: false` opt-out path). */
export function restoreRealSpecClock(): void {
  globalThis.Date = RealDate;
  installedInstant = undefined;
}

/** The instant the spec-process clock is currently frozen to, if it is. */
export function frozenSpecClockInstant(): number | undefined {
  return installedInstant;
}

const initialInstant = resolveSpecClockFreeze();
if (initialInstant !== undefined) installFrozenSpecClock(initialInstant);
