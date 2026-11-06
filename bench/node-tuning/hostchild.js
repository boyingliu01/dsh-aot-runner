// 复现 dsh-tool-fs 的 read_file：10 路并发，每路 stat → readFile
'use strict';
const { stat, readFile } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(path.resolve(__dirname, '..', '..'), 'src');
const FILES = fs.readdirSync(ROOT).filter(f => f.endsWith('.cs')).map(f => path.join(ROOT, f));
const PARALLEL = 10;

(async () => {
  await stat(FILES[0]); await readFile(FILES[0]);
  const s = []; const R = 30;
  for (let r = 0; r < R; r++) {
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({length: PARALLEL}, async (_, i) => {
      const f = FILES[i % FILES.length];
      await stat(f);          // dsh-tool-fs 先 stat 判断类型和版本
      await readFile(f);      // 然后读
    }));
    s.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const mean = s.reduce((a,b)=>a+b,0)/R;
  const sd = Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/(R-1));
  s.sort((a,b)=>a-b);
  process.stdout.write(`${s[Math.floor(R/2)].toFixed(3)} ${sd.toFixed(3)}`);
})();
