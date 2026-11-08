// 分段耗时探针 —— 回答「启动到结果回报之间，每一段各花了多久」
//
// 为什么需要这个文件（这是本项目的核心教训）：
//   bench/d1-ab-bench.js 只给端到端 p50，它能告诉你「A 比 B 快」，
//   但说不出「快/慢的这几毫秒在哪个函数里」。
//   2026-11-07 曾据此推断「PollLoop 的 Sleep(10) 值 5ms」，实测完全测不出 ——
//   因为那 10ms 被 target 自身启动时间掩盖了。
//   结论：改内部实现之前，先用这个探针确认热点真的在那儿。
//
// 依据来源：runner 内 Trace.Phase 打出的 [phase] 行，微秒精度。
// 开关：DSH_AOT_DEBUG=1 + DSH_AOT_DEBUG_FILE 指向一个空文件。
//
// 用法：
//   node bench/phase-probe.js [--n 40] [--target "cmd /c exit 0"]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const N = Number(arg('n', 40));
const TARGET = arg('target', 'cmd /c exit 0').split(' ');
const RUNNER = arg('runner', path.join(REPO, 'dist', 'dsh-aot-runner.exe'));

/** 跑一次 runner，返回该次调用产生的 [phase] 记录。 */
function once(traceFile) {
  return new Promise((resolve) => {
    fs.writeFileSync(traceFile, '');
    const t0 = process.hrtime.bigint();
    const child = spawn(RUNNER, ['--', ...TARGET], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_AOT_DEBUG: '1', DSH_AOT_DEBUG_FILE: traceFile },
    });
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      // 给 Trace 的文件写入一点时间落盘
      setTimeout(() => {
        const text = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '';
        const phases = {};
        for (const m of text.matchAll(/\[phase\] (\S+)\s+(\d+)us/g)) {
          phases[m[1]] = Number(m[2]);
        }
        resolve({ totalMs, phases });
      }, 30);
    };
    child.on('message', fin);
    child.on('exit', fin);
    child.on('error', fin);
    child.stdio[4]?.on('data', () => {});
    if (child.send) child.send({ type: 'start', cwd: process.cwd(), env: process.env });
    setTimeout(fin, 10000);
  });
}

const stat = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.round(s.length * q))];
  return { p10: p(0.1), p50: p(0.5), p90: p(0.9), max: s[s.length - 1] };
};

(async () => {
  if (!fs.existsSync(RUNNER)) {
    console.error(`找不到 runner: ${RUNNER}\n先跑 ./build.sh`);
    process.exit(1);
  }
  const traceFile = path.join(os.tmpdir(), `aot-phase-${process.pid}.log`);
  const results = [];
  for (let i = 0; i < N; i++) results.push(await once(traceFile));
  fs.rmSync(traceFile, { force: true });

  const names = new Set();
  results.forEach((r) => Object.keys(r.phases).forEach((k) => names.add(k)));
  if (names.size === 0) {
    console.error('没有采集到任何 [phase] 记录 —— 确认 runner 是带探针的新版本');
    process.exit(1);
  }

  console.log(`\n分段耗时（微秒，n=${N}，target=${TARGET.join(' ')}）`);
  console.log('─'.repeat(62));
  console.log('分段'.padEnd(20) + 'p10'.padStart(10) + 'p50'.padStart(10) + 'p90'.padStart(10) + 'max'.padStart(10));
  const measured = [];
  for (const name of names) {
    const vals = results.map((r) => r.phases[name]).filter((v) => v !== undefined);
    if (!vals.length) continue;
    const st = stat(vals);
    measured.push([name, st.p50]);
    console.log(
      name.padEnd(20)
      + String(st.p10).padStart(10) + String(st.p50).padStart(10)
      + String(st.p90).padStart(10) + String(st.max).padStart(10),
    );
  }
  const sumP50 = measured.reduce((a, [, v]) => a + v, 0);
  const totals = stat(results.map((r) => r.totalMs));
  console.log('─'.repeat(62));
  console.log(`分段 p50 之和: ${(sumP50 / 1000).toFixed(2)}ms`);
  console.log(`端到端   p50  : ${totals.p50.toFixed(1)}ms  (p10=${totals.p10.toFixed(1)} p90=${totals.p90.toFixed(1)})`);
  console.log(`未被分段的占比: ${(100 * (1 - sumP50 / 1000 / totals.p50)).toFixed(1)}%（进程创建 + target 启动 + 结果回传）`);

  const hot = measured.slice().sort((a, b) => b[1] - a[1])[0];
  if (hot && hot[1] > 500) {
    console.log(`\n最大分段: ${hot[0]} = ${(hot[1] / 1000).toFixed(2)}ms`);
  }
})();
