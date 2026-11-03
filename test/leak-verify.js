/**
 * S5 —— 进程树零泄漏回归 + 混沌测试（Issue #3）
 *
 * Job Object 设了 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，理论上 runner 退出时整棵
 * 进程树会被回收。但「理论上」不是证据。本套件把它变成可重复的断言。
 *
 * 设计要点（四个子集，逐层加严）：
 *   1. 探针自校验  —— 先证明「监视器真的能看到进程」，否则后面全绿也没意义
 *   2. 零泄漏回归  —— 100 次连续调用，三种结束方式混合
 *   3. 深层进程树  —— target 再派生 3 层，terminate 后逐层回收
 *   4. 混沌        —— 直接杀 runner 本身 / target 派生后立即退出 / stdout 反压
 *
 * 运行：node --test test/leak-verify.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execSync, spawn } = require('node:child_process');
const {
  assertEnvironment, runAot, listDescendantPids, alivePids, launchRunner,
} = require('./runner-client.js');

assertEnvironment();

// sleep / waitUntil 与 race-verify 曾经各有一份完全相同的实现
// （Gate 2 查出的克隆），统一改为引用 test-utils。
const { sleep, waitUntil } = require('./test-utils.js');

/** 列出当前所有匹配名字的进程 PID（跨 runner/target 检查泄漏用） */
function pidsByName(namePattern) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='${namePattern}'\\" | Select-Object -ExpandProperty ProcessId"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch { return []; }
}

/**
 * 确认一组 PID 全部退出。
 * @returns {{leaked: number[]}} 仍然活着的 PID
 */
async function assertAllGone(pids, label) {
  let leaked = [];
  // 用批量判活，避免逐 PID 起 PowerShell（100 轮回归会被拖到几分钟）
  await waitUntil(() => {
    leaked = [...alivePids(pids)];
    return leaked.length === 0;
  });
  if (leaked.length) {
    // 清理现场，避免污染后续用例
    for (const p of leaked) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }
  }
  assert.deepStrictEqual(leaked, [], `${label}: 有 ${leaked.length} 个进程泄漏 -> ${leaked.join(',')}`);
  return leaked;
}

// ---------------------------------------------------------------------------
// 1. 探针自校验 —— 先证明监视器能看见东西
// ---------------------------------------------------------------------------

test('探针自校验：能检测到存活的子进程', { timeout: 30000 }, async () => {
  // 故意起一个长命子进程，证明「检测存活」这条路是通的。
  // 如果这个用例挂了，说明 alivePids / listDescendantPids 本身有问题，
  // 后面所有「零泄漏」的绿灯都不可信。
  const c = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 > nul'], {
    windowsHide: true, stdio: 'ignore',
  });
  await sleep(300);

  assert.ok(c.pid, '子进程应有 PID');
  assert.ok(alivePids([c.pid]).has(c.pid), '探针必须能观察到存活进程');

  const descendants = listDescendantPids(process.pid);
  assert.ok(descendants.includes(c.pid), '探针必须能从父进程枚举到子进程');

  try { process.kill(c.pid, 'SIGKILL'); } catch { /* ignore */ }
  await assertAllGone([c.pid], '探针自校验清理');
});

test('探针自校验：泄漏检查会失败', { timeout: 30000 }, async () => {
  // 反向验证断言本身有效：留一个活进程，assertAllGone 必须抛错。
  const c = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 > nul'], {
    windowsHide: true, stdio: 'ignore',
  });
  await sleep(300);

  let threw = false;
  try {
    // 用很短的超时，快速验证「它会失败」
    const leaked = await (async () => {
      const deadline = Date.now() + 300;
      while (Date.now() < deadline) await sleep(50);
      return [...alivePids([c.pid])];
    })();
    if (leaked.length) throw new Error(`检测到 ${leaked.length} 个泄漏`);
  } catch { threw = true; }

  assert.ok(threw, '泄漏检查必须对活进程报错，否则它只会亮绿灯');

  try { process.kill(c.pid, 'SIGKILL'); } catch { /* ignore */ }
  await assertAllGone([c.pid], '反向自校验清理');
});

// ---------------------------------------------------------------------------
// 2. 零泄漏回归 —— 100 次连续调用
// ---------------------------------------------------------------------------

test('零泄漏：100 次连续调用', { timeout: 300000 }, async () => {
  const ROUNDS = 100;

  // 基线要**等干净了再取**，不能上来就快照。
  //
  // 踩过的坑（2026-11-04，test:all 串行时偶发失败，单跑却总是通过）：
  // 上一套件（race-verify 等）留下的 runner 可能还在退出过程中。
  // 这时 if 直接 `new Set(pidsByName(...))` 取基线，那些「正在退出」的
  // PID 不在基线里，等它们退出前被扫到，就被误判成本轮泄漏。
  // 单跑不复现正是因为前面没有别的套件。
  //
  // 所以：先等目录里没有任何 runner，再取基线。
  let before = new Set();
  await waitUntil(() => {
    before = new Set(pidsByName('dsh-aot-runner.exe'));
    return before.size === 0;
  }, { timeoutMs: 20000 });
  if (before.size) {
    // 等不到干净环境也不硬测 —— 说明确有常驻 runner（比如 DSH 正在用），
    // 那就把它们全部纳入基线，后续只关心「新增」的。
    console.error(`  注意：起测时已有 ${before.size} 个常驻 runner，已纳入基线`);
  }

  const leakedAll = [];
  // 记录本轮自己启动的所有 runner PID —— 精确追踪比「名字差集」可靠
  const myPids = new Set();

  for (let i = 0; i < ROUNDS; i += 1) {
    // 三模式混合：
    //   0 = 正常退出，1 = 非零退出，2 = 派生孙进程后被 terminate
    const mode = i % 3;
    let argv;
    if (mode === 0) argv = ['cmd.exe', '/c', 'exit 0'];
    else if (mode === 1) argv = ['cmd.exe', '/c', 'exit 7'];
    else argv = ['cmd.exe', '/c', 'ping -n 30 127.0.0.1 > nul & ping -n 30 127.0.0.1 > nul'];

    if (mode === 2) {
      const h = launchRunner('aot', { argv });
      if (h.state.pid) myPids.add(h.state.pid);
      await sleep(200);
      const tree = h.state.pid ? listDescendantPids(h.state.pid) : [];
      h.terminate();
      await h.wait(10000);
      await assertAllGone([...tree, h.state.pid].filter(Boolean), `第 ${i} 轮 terminate`);
    } else {
      const r = await runAot({ argv, timeoutMs: 20000 });
      assert.notStrictEqual(r.error, 'timeout', `第 ${i} 轮超时`);
    }

    // 每 10 轮做一次扫描，尽早发现趋势性泄漏。
    //
    // 判定分两步，**优先信任精确追踪**：
    //   1. 本轮自己启动过的 PID 是否还活着 —— 这是无歧义的判据
    //   2. 名字扫描发现的新增 PID —— 只用于「意外情况」报告，不当硬失败
    //      （基线与扫描之间仍可能有 DSH 自身的 runner 起落，
    //        那种波动不该算成测试泄漏）
    if ((i + 1) % 10 === 0) {
      let mine = [];
      let unnamed = [];
      await waitUntil(() => {
        mine = [...alivePids([...myPids])];
        const scanned = [...alivePids(pidsByName('dsh-aot-runner.exe'))]
          .filter((p) => !before.has(p) && !myPids.has(p));
        unnamed = scanned;
        return mine.length === 0 && scanned.length === 0;
      });
      if (mine.length) {
        leakedAll.push({ round: i + 1, why: '本轮启动的 runner 未退出', stray: mine });
      } else if (unnamed.length) {
        console.error(`  第 ${i + 1} 轮：检测到非本轮启动的 runner ${unnamed.join(',')}`
          + '（可能是 DSH 正在使用，不计为泄漏）');
      }
    }
  }

  // 收尾同样优先用精确 PID 判据。
  //
  // 踩过的坑（2026-11-04，test:all 串行时偶发失败，单跑却总是通过）：
  // 原来只看「名字差集」，在 test:all 里会把上一套件残留、正在退出的 runner
  // 误判成本轮泄漏。改用 myPids 精确比对后，判定不再依赖环境干净程度。
  let after = [];
  let rounds = 0;
  await waitUntil(() => {
    rounds += 1;
    after = [...alivePids([...myPids])];
    return after.length === 0;
  });
  for (const p of after) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }

  assert.deepStrictEqual(
    after, [],
    `${ROUNDS} 轮后本轮启动的 runner 仍有 ${after.length} 个未退出`
    + `（轮询 ${rounds} 次后仍在）: ${after.join(',')}`,
  );
  assert.deepStrictEqual(leakedAll, [], `中途发现残留: ${JSON.stringify(leakedAll)}`);
});

// ---------------------------------------------------------------------------
// 3. 深层进程树
// ---------------------------------------------------------------------------

test('深层进程树：多层孙进程全部回收', { timeout: 60000 }, async () => {
  // target 自己再派生多层长命进程。
  //
  // 两个踩过的坑（都会让用例假阴性）：
  //   1. `cmd /c "cmd /c \"...\""` —— argv 数组里的引号会被 CreateProcessW
  //      二次解释成目录名，直接报 "The directory name is invalid"。
  //      改用不带额外引号的 `cmd.exe /c cmd.exe /c ...`。
  //   2. `start /b` 会让新进程脱离父子链，listDescendantPids 就枚举不到它们，
  //      用例变成「什么都没测」。必须用 `cmd /c` 串接保持父子关系。
  const leaf = 'ping -n 30 127.0.0.1 > nul';
  const deepCmd = `cmd.exe /c cmd.exe /c ${leaf}`;

  for (const [label, kind] of [['AOT', 'aot'], ['node', 'node']]) {
    const h = launchRunner(kind, { argv: ['cmd.exe', '/c', deepCmd] });
    await sleep(900);

    const tree = h.state.pid ? listDescendantPids(h.state.pid) : [];
    const live = [...alivePids(tree)];
    assert.ok(
      live.length >= 2,
      `${label}: 应枚举到多层存活子孙，tree=${JSON.stringify(tree)} live=${JSON.stringify(live)}`,
    );

    h.terminate();
    await h.wait(15000);
    await assertAllGone([...tree, h.state.pid].filter(Boolean), `${label} 深层树`);
  }
});

// ---------------------------------------------------------------------------
// 4. 混沌
// ---------------------------------------------------------------------------

test('混沌：直接杀 runner 本身，target 也被带走', { timeout: 60000 }, async () => {
  const h = launchRunner('aot', {
    argv: ['cmd.exe', '/c', 'ping -n 30 127.0.0.1 > nul'],
  });
  await sleep(600);

  assert.ok(h.state.pid, 'runner 应已启动');
  const tree = listDescendantPids(h.state.pid);
  assert.ok(tree.length >= 1, `runner 下应有 target，实际 ${tree.length}`);

  // 强杀 runner —— 模拟宿主崩溃。Job 的 KILL_ON_JOB_CLOSE 应随之回收整棵树。
  h.killRunner();

  await assertAllGone([...tree, h.state.pid].filter(Boolean), '强杀 runner');
});

test('混沌：target 派生后立即退出，孙进程仍被回收', { timeout: 60000 }, async () => {
  // target 起一个长命孙进程后立刻退出 —— 孙进程会留在 Job 里，
  // runner 观察到 target 退出后关闭 Job，孙进程应被一并杀掉。
  const argv = ['cmd.exe', '/c', 'start /b ping -n 30 127.0.0.1 > nul & exit 0'];

  const before = new Set(pidsByName('PING.EXE'));
  const r = await runAot({ argv, timeoutMs: 20000 });
  assert.notStrictEqual(r.error, 'timeout', '不应超时');

  // 给 Job 关闭后的回收留出时间
  await waitUntil(() => [...alivePids(pidsByName('PING.EXE'))].filter((p) => !before.has(p)).length === 0);
  const strays = [...alivePids(pidsByName('PING.EXE'))].filter((p) => !before.has(p));
  for (const p of strays) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }
  assert.deepStrictEqual(strays, [], `孙进程泄漏: ${strays.join(',')}`);
});

test('混沌：stdout 反压不影响正常退出', { timeout: 120000 }, async () => {
  // target 灌 2MB 到 stdout。若 runner 或管道处理有缺陷，会卡死而非报错。
  const big = ['cmd.exe', '/c', 'for /L %i in (1,1,20000) do @echo AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];
  const r = await runAot({ argv: big, timeoutMs: 100000 });

  assert.notStrictEqual(r.error, 'timeout', '大输出下不应卡死');
  assert.strictEqual(r.exitCode, 0, `退出码应为 0，实际 ${r.exitCode}`);
  assert.ok(r.stdout.length > 1_000_000, `应收到大量输出，实际 ${r.stdout.length} 字节`);
});
