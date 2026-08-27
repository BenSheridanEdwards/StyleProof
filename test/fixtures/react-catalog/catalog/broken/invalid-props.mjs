// Deliberately NOT JSON: a variant prop carrying a function cannot survive a
// JSON round-trip, so validateComponentManifest must reject it and the harness
// must surface an `invalid-props` diagnostic — never silently drop the function.
export default {
  version: 1,
  components: [
    {
      id: 'button',
      module: 'test/fixtures/react-catalog/catalog/components/Button.jsx',
      export: 'Button',
      variants: [{ key: 'default', props: { label: 'Save', onClick: () => {} } }],
    },
  ],
};
