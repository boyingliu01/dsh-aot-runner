// 子进程任务：读 1 个文件，打印纯 fs 耗时（ms）
// 单独成文件而不是用 -e，避免 argv 索引差异带来的坑
'use strict';
const fs = require('fs');

const t0 = process.hrtime.bigint();
fs.readFile(process.argv[2], (err) => {
  const t1 = process.hrtime.bigint();
  if (err) { console.error(err.message); process.exit(1); }
  process.stdout.write(String(Number(t1 - t0) / 1e6));
});
