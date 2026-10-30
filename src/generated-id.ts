// Sources, rather than RegExp objects, survive Playwright's page argument serialization.
export const GENERATED_ID_SOURCES = [
  // React useId (18–19.2), optionally following an identifier prefix; also covers Radix's
  // `radix-${useId()}` and modern Headless UI/Chakra ids. Never match an interior token.
  /^(?:[A-Za-z_][A-Za-z0-9_-]*)?(?::[rR][0-9A-Za-z]+:|«[rR][0-9A-Za-z]+»|_[rR]_[0-9A-Za-z]+_)$/.source,
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
  // Angular Material/CDK component counters, e.g. mat-input-0 and cdk-overlay-0.
  /^(?:mat|cdk)-[a-z]+-[0-9]+$/.source,
  // Vue 3.5 useId: v-<counter>, with numeric async boundary segments.
  /^v-[0-9]+(?:-[0-9]+)*$/.source,
  // Ten hex characters avoids short dictionary-like ids such as facade01.
  /^[0-9a-f]{10,}$/i.source,
];
