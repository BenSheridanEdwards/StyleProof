// Production app entry WITHOUT the StyleProof catalog: the negative control
// for the bundle exclusion oracle. It imports nothing — no react, no catalog,
// no marker — so a production bundle of it must stay free of both.
document.body.innerHTML = '<main data-fixture="plain-app">Production app without the catalog</main>';
