// Sources, rather than RegExp objects, survive Playwright's page argument serialization.
export const GENERATED_ID_SOURCES = [
  // React useId tokens can occur inside library-derived ids, including before suffixes.
  // Require a separator after an identifierPrefix: arbitrary prefixes cannot distinguish
  // React's ba + r2 from authored a:bar2:b. Counters use base 32, with server H suffixes.
  // Underscore coordinate segments (cell_r_1_c_2) remain authored when embedded in a word.
  // This also keeps the React-looking foo_r_1_bar_ stable, a known gap in the heuristic.
  /(?::(?:[A-Za-z0-9_-]*[-_])?[rR][0-9a-v]+(?:H[0-9a-v]+)?:|«(?:[A-Za-z0-9_-]*[-_])?[rR][0-9a-v]+(?:H[0-9a-v]+)?»|(?:^|[^A-Za-z0-9])_(?:[A-Za-z0-9_-]*[-_])?[rR]_[0-9a-v]+(?:H[0-9a-v]+)?_|_(?:[A-Za-z0-9_-]*[-_])?[rR]_[0-9a-v]+(?:H[0-9a-v]+)?_(?![A-Za-z0-9]+_))/
    .source,
  // Chakra v1 useIds counters, including derived modal header ids.
  /^chakra-(?:[a-z]+-+)+[0-9]+$/.source,
  // Radix's pre-React-18 counter fallback and MUI's useGlobalId fallback.
  /^(?:radix|mui)-[0-9]+$/.source,
  // Headless UI's component names followed by its legacy useId counter.
  /^headlessui-(?:[a-z]+-)+[0-9]+$/.source,
  // React Aria SSRProvider: react-aria-<counter> or react-aria<seed>-<counter>.
  /^react-aria-?[0-9]+(?:-[0-9]+)*$/.source,
  // Floating UI's pre-React-18 fallback: four random base36 chars, then a counter.
  /^floating-ui-[0-9a-z]{4}[0-9]+$/.source,
  // Downshift's counter base and the element ids derived from it.
  /^downshift-[0-9]+(?:-(?:input|label|menu|toggle-button|item-[0-9]+))?$/.source,
  // Reach's legacy component ids (use a numeric auto-id, sometimes nested).
  /^reach-(?:[a-z]+-)+[0-9]+(?:-[0-9]+)*$/.source,
  // Angular Material/MDC and CDK counters, including numeric and named suffixes.
  /^(?:mat|cdk)-(?:[a-z]+-)+[0-9]+(?:-(?:[a-z]+|[0-9]+))*$/.source,
  // Vue 3.5 useId: v-<counter>, with numeric async boundary segments.
  /^v-[0-9]+(?:-[0-9]+)*$/.source,
  // Ten hex characters avoids short dictionary-like ids such as facade01.
  /^[0-9a-f]{10,}$/i.source,
];
