// The modal's provider module. The broken/missing-provider.json manifest
// declares it, and this file exists on disk — but the fixture's dev entry
// (modules.mjs) deliberately does NOT wire it into the static registry, which
// is exactly the divergence the missing-provider diagnostic exists to find.
export function ModalProvider({ children }) {
  return children;
}

export default ModalProvider;
