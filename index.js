'use strict';

const core = require('./src/core');
const { run } = require('./src/run');

// process.exitCode rather than process.exit(): buffered stdout (the workflow commands and
// step summary writes) must flush before the process ends, or a failure message can be
// lost and the step reports a bare exit code with no explanation.
run(core)
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    core.error(`Unexpected failure in the Tower deploy action: ${err?.stack || err}`);
    process.exitCode = 1;
  });
