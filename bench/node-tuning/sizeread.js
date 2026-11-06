'use strict';
const { readFile } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, process.argv[2]);
const FILES = fs.readdirSync(DIR).map(f => path.join(DIR, f)).sort();
const N = parseInt(process.argv[3], 10) || 10;
(async () => {
  const s=[]; const R=7;
  for (let r=0;r<R;r++){
    const t0=process.hrtime.bigint();
    await Promise.all(Array.from({length:N},(_,i)=>readFile(FILES[i%FILES.length])));
    s.push(Number(process.hrtime.bigint()-t0)/1e6);
  }
  s.sort((a,b)=>a-b);
  process.stdout.write(s[Math.floor(R/2)].toFixed(2));
})();
