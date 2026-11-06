/**
 * 实验 R：找出「文件多大才开始受益」的边界，并对照 DSH 真实文件大小
 *
 * ## 为什么这一步是决定性的
 *
 * 实验 Q 证实 fs 确实走线程池，大文件并发读提速 20~29%。
 * 所以"UV_THREADPOOL_SIZE 无效"这个结论**只在小文件下成立**。
 *
 * 那 DSH 日常处理的是什么大小的文件？这决定了优化值不值得做。
 * 本实验扫过 4KB ~ 16MB，画出受益曲线。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHILD = path.join(__dirname, 'sizeread.js');
const ROUNDS = parseInt(process.argv[2], 10) || 12;
const CONCURRENCY = 10;   // 对齐 maxParallelToolCalls
const SIZES = ['4KB', '32KB', '128KB', '512KB', '2MB', '8MB', '16MB'];

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

function once(tps, dir) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, dir, String(CONCURRENCY)], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(tps) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('close', () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) ? v : null);
    });
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  // 生成各尺寸测试数据
  for (const sz of SIZES) {
    const dir = `sz2-${sz}`;
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    const m = /^(\d+)(KB|MB)$/.exec(sz);
    const bytes = parseInt(m[1], 10) * (m[2] === 'MB' ? 1048576 : 1024);
    const buf = require('crypto').randomBytes(bytes);
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(dir, `f${i}.bin`), buf);
  }

  console.log(`实验 R：受益边界扫描（${CONCURRENCY} 路并发 × ${ROUNDS} 轮交错）\n`);
  console.log('  文件大小   每路数据   TPS=4      TPS=16     变化');
  console.log('  ────────────────────────────────────────────────────');

  for (const sz of SIZES) {
    const a = [], b = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const x = await once(4, `sz2-${sz}`);
      const y = await once(16, `sz2-${sz}`);
      if (x !== null) a.push(x);
      if (y !== null) b.push(y);
    }
    const delta = (median(b) / median(a) - 1) * 100;
    console.log(
      `  ${sz.padEnd(9)} ${(sz + '×10').padEnd(10)} `
      + `${median(a).toFixed(2).padStart(8)}ms ${median(b).toFixed(2).padStart(8)}ms `
      + `${(delta >= 0 ? '+' : '') + delta.toFixed(1) + '%'}`.padStart(9),
    );
  }

  console.log('');
  console.log('  对照 DSH 真实场景:');
  console.log('    read_file 典型文件 4KB~128KB → 落在无收益区间');
  console.log('    glob/grep 只 stat 不读内容 → 元数据操作，单次 0.02ms');
  console.log('    大文件（>2MB）才受益，但那是少数场景');
})();
