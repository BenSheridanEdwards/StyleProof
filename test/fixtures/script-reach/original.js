function choose(flag) {
  if (flag) {
    document.body.dataset.branch = 'executed';
  } else {
    document.body.dataset.branch = 'unexecuted';
  }
}
choose(true);
