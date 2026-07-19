/**
 * The spec-process half of `freezeClock` (see `DefineOptions.freezeClock`).
 *
 * `freezeClock` has always pinned the BROWSER clock (`page.clock.setFixedTime`),
 * but capture specs routinely compute fixture values in the SPEC's Node process —
 * a module-level `const GENERATED_AT = new Date().toISOString()` runs before any
 * test executes, outside the browser freeze. Such a value differs between the
 * base and the head capture run (separate processes, minutes or days apart), so
 * any surface rendering it as text drifts in width and shows up in the diff as a
 * phantom computed-style change on an unrelated PR. The in-run self-check cannot
 * catch this class: both of its captures share one spec process and therefore
 * one value.
 *
 * `styleproof-map` sets `STYLEPROOF_FREEZE_SPEC_CLOCK=1` for the Playwright run
 * it spawns. Importing this module — a side effect of importing `styleproof`,
 * which a capture spec does before evaluating its own constants — then swaps
 * `globalThis.Date` for a frozen twin: zero-argument construction, `Date.now()`,
 * and bare `Date()` calls report `STYLEPROOF_CLOCK_TIME` (default
 * `DEFAULT_CLOCK_TIME`, matching the browser freeze), while explicit-argument
 * construction, `Date.parse`/`Date.UTC`, and every instance method behave
 * normally. StyleProof's own elapsed-time bookkeeping (settle windows, popup
 * deadlines, manifest stamps) reads `realNow()`, captured before the swap.
 *
 * Opt out with `STYLEPROOF_FREEZE_SPEC_CLOCK=0` on the capture command;
 * `freezeClock: false` in the spec also restores the real clock at define time.
 */

/** The default frozen instant, shared with the browser-side freeze (`DefineOptions.clockTime`). */
export const DEFAULT_CLOCK_TIME = '2025-01-01T00:00:00Z';

const RealDate = globalThis.Date;

/** Wall-clock milliseconds from the real clock, immune to the spec-clock freeze. */
export function realNow(): number {
  return RealDate.now();
}

let installedInstant: number | undefined;

/**
 * Resolve whether (and at what instant) the spec-process clock should freeze:
 * `undefined` unless `STYLEPROOF_FREEZE_SPEC_CLOCK=1`; the instant comes from
 * `STYLEPROOF_CLOCK_TIME` (ISO string or epoch milliseconds), defaulting to
 * `DEFAULT_CLOCK_TIME`. An unparseable instant throws — a silently-ignored typo
 * would run the capture on the live clock while claiming determinism.
 */
export function resolveSpecClockFreeze(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.STYLEPROOF_FREEZE_SPEC_CLOCK !== '1') return undefined;
  const configured = env.STYLEPROOF_CLOCK_TIME ?? DEFAULT_CLOCK_TIME;
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
 * Swap `globalThis.Date` for a frozen twin pinned to `fixedMilliseconds`. A Proxy
 * over the real constructor, so `Date.parse`/`Date.UTC`, the prototype, and
 * `instanceof` all keep working; only zero-argument construction, `now()`, and
 * bare `Date()` calls are redirected to the fixed instant.
 */
export function installFrozenSpecClock(fixedMilliseconds: number): void {
  const frozen = new Proxy(RealDate, {
    construct(target, argumentsList: unknown[], newTarget) {
      const effective = argumentsList.length === 0 ? [fixedMilliseconds] : argumentsList;
      return Reflect.construct(target, effective, newTarget) as object;
    },
    apply() {
      // `Date()` without `new` reports the current time as a string.
      return new RealDate(fixedMilliseconds).toString();
    },
    get(target, property, receiver) {
      if (property === 'now') return () => fixedMilliseconds;
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
