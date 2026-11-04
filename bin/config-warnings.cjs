// Required synchronously in config-loading children, before Node 22.13 emits
// its startup type-stripping warning (an asynchronous --import is too late).
// Node's module-type diagnostic can bypass process.emitWarning, so filter the
// default warning printer; user warning listeners and trace options still work.
const process = require('node:process');
const printWarning = process.listeners('warning').find((listener) => listener.name === 'onWarning');
if (printWarning) {
  process.off('warning', printWarning);
  process.on('warning', (warning) => {
    if (
      warning.code === 'MODULE_TYPELESS_PACKAGE_JSON' &&
      /^Module type of file:.*\/(?:styleproof|playwright\.styleproof)\.config\.ts is not specified and it doesn't parse as CommonJS\./.test(
        warning.message,
      )
    )
      return;
    if (!warning.code) {
      if (
        warning.name === 'ExperimentalWarning' &&
        warning.message === 'Type Stripping is an experimental feature and might change at any time'
      )
        return;
      if (
        warning.name === 'Warning' &&
        (warning.message ===
          'To load an ES module, set "type": "module" in the package.json or use the .mjs extension.' ||
          /^Failed to load the ES module: .*[/\\](?:styleproof|playwright\.styleproof)\.config\.ts\. Make sure to set "type": "module" in the nearest package\.json file or use the \.mjs extension\.$/.test(
            warning.message,
          ))
      )
        return;
    }
    printWarning.call(process, warning);
  });
}
