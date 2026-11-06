// 固定总任务数、可调并发度，测 stat 吞吐
'use strict';
const { stat } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'tiny');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();
const INFLIGHT = parseInt(process.argv[2], 10) || 4;
const TOTAL = parseInt(process.argv[3], 10) || 2000;

(async () => {
  await stat(FILES[0]);
  const t0 = process.hrtime.bigint();
  let next = 0;
  const worker = async () => {
    while (next < TOTAL) {
      const i = next;
      next += 1;
      await stat(FILES[i % FILES.length]);
    }
  };
  await Promise.all(Array.from({ length: INFLIGHT }, worker));
  process.stdout.write((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3));
})();
