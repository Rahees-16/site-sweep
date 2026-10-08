#!/usr/bin/env node
'use strict';
const { run } = require('../src/index');
run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`site-sweep: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  }
);
