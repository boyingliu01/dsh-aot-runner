// 读 N 个文件后退出，用于拆解「进程启动 vs fs」的成本构成
'use strict';
const { readFile } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'files');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();
const N = parseInt(process.argv[2], 10) || 0;

(async () => {
  for (let i = 0; i < N; i += 1) {
    await readFile(FILES[i % FILES.length]);
  }
})();
