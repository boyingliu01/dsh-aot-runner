/**
 * S3 —— terminate 竞态场景测试（Issue #4）
 *
 * 覆盖四类竞态窗口：
 *   1. start 后立即 terminate（0/1/5/10/25ms）
 *   2. terminate 一个已退出的 target（应正常收尾，不崩溃）
 *   3. terminate 早于 start 到达
 *   4. 连续 start/terminate 交替，检查进程与句柄残留
 *
 * 判定一律落在**可观测的事实**上：协议结果、进程存活、进程树残留，
 * 而不是「没抛异常」。竞态缺陷最典型的表现恰恰是「不抛异常但状态错误」。
 *
 * 运行：node --test test/race-verify.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  assertEnvironment, launchRunner, listDescendantPids, alivePids,
} = require('./runner-client.js');

assertEnvironment();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 竞态用例**必须串行**。
// node --test 默认并发跑顶层 test()，而本套件每个用例都会起大量真实进程；
// 并行时它们互相抢占 CPU/句柄，导致计时失准甚至超时 ——
// 竞态测试一旦被外部干扰，测的就不再是被测对象的行为。
// 用 { concurrency: 1 } 把整组钉成顺序执行。
const RACE = { concurrency: 1 };

/** 轮询等待条件成立 */
async function waitUntil(pred, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(intervalMs);
  }
  return pred();
}

/** 确认一组 PID 全部退出，返回仍存活者 */
async function allGone(pids, label) {
  let leaked = [];
  await waitUntil(() => {
    leaked = [...alivePids(pids)];
    return leaked.length === 0;
  });
  if (leaked.length) {
    for (const p of leaked) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }
  }
  assert.deepStrictEqual(leaked, [], `${label}: 残留进程 ${leaked.join(',')}`);
  return leaked;
}

/** 起一个会跑很久的 target，便于观察 terminate 效果 */
const LONG = ['cmd.exe', '/c', 'ping -n 60 127.0.0.1 > nul'];

// ---------------------------------------------------------------------------
// 1. start 后立即 terminate
// ---------------------------------------------------------------------------

test('竞态：start 后立即 terminate（多种延迟）', { timeout: 240000, ...RACE }, async () => {
  // terminate 与 CreateProcessW / AssignProcessToJobObject / ResumeThread
  // 交错执行。每个延迟重复多次，因为时序缺陷是概率性的。
  const delays = [0, 1, 5, 10, 25];
  const REPEAT = 8;

  for (const delayMs of delays) {
    for (let i = 0; i < REPEAT; i += 1) {
      const h = launchRunner('aot', { argv: LONG });
      if (delayMs > 0) await sleep(delayMs);
      h.terminate();

      const st = await h.wait(15000);
      // 必须收到一个终态结果（target-exit 或 error），不能什么都没有
      assert.ok(
        st.result !== null,
        `delay=${delayMs}ms 第 ${i} 次: 未收到任何终态结果（runner 可能卡死）`,
      );

      // runner 自身必须退出
      await sleep(120);
      await allGone([h.state.pid].filter(Boolean), `delay=${delayMs}ms 第 ${i} 次 runner`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. terminate 一个已退出的 target
// ---------------------------------------------------------------------------

test('竞态：terminate 已退出的 target 不崩溃', { timeout: 120000, ...RACE }, async () => {
  const h = launchRunner('aot', { argv: ['cmd.exe', '/c', 'exit 0'] });

  // 等 target 正常退出、结果已投递
  const st = await h.wait(10000);
  assert.ok(st.result !== null, '正常退出应收到结果');
  assert.strictEqual(st.result.type, 'target-exit', `应为 target-exit，实际 ${JSON.stringify(st.result)}`);

  // 事后再发 terminate —— 不应导致崩溃，也不应改变已投递的结果
  const before = JSON.stringify(st.result);
  h.terminate();
  await sleep(500);

  assert.strictEqual(
    JSON.stringify(h.state.result), before,
    'terminate 不得覆盖已投递的终态结果',
  );
  await allGone([h.state.pid].filter(Boolean), '已退出 target 后 terminate');
});

// ---------------------------------------------------------------------------
// 3. terminate 早于 start 到达
// ---------------------------------------------------------------------------

test('竞态：terminate 先于 start 到达', { timeout: 120000, ...RACE }, async () => {
  // 构造最极端的窗口：目标命令是一个**不存在的程序**，
  // 让 spawn 必然失败，同时 terminate 紧贴着到达。
  // 这里验证的是「无论先后，都必须有一个确定的结果且 runner 退出」。
  for (let i = 0; i < 10; i += 1) {
    const h = launchRunner('aot', { argv: LONG });
    h.terminate();       // 立即，可能早于 start 被 runner 读到
    h.terminate();       // 重复发，验证幂等

    const st = await h.wait(15000);
    assert.ok(st.result !== null, `第 ${i} 次: 未收到结果`);
    await sleep(120);
    await allGone([h.state.pid].filter(Boolean), `第 ${i} 次 runner`);
  }
});

// ---------------------------------------------------------------------------
// 4. 连续 start/terminate 交替，检查残留
// ---------------------------------------------------------------------------

test('竞态：start/terminate 交替 60 轮无残留', { timeout: 300000, ...RACE }, async () => {
  const before = new Set(process.pid ? listDescendantPids(process.pid) : []);
  const ROUNDS = 60;

  for (let i = 0; i < ROUNDS; i += 1) {
    const h = launchRunner('aot', { argv: LONG });
    await sleep(i % 3 === 0 ? 0 : 15);
    h.terminate();
    const st = await h.wait(10000);
    assert.ok(st.result !== null, `第 ${i} 轮: 未收到结果`);

    await sleep(80);
    await allGone([h.state.pid].filter(Boolean), `第 ${i} 轮 runner`);

    // 每 15 轮做一次全局扫描，尽早发现趋势性泄漏
    if ((i + 1) % 15 === 0) {
      const descendants = listDescendantPids(process.pid);
      const stray = [...alivePids(descendants)].filter((p) => !before.has(p));
      for (const p of stray) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }
      assert.deepStrictEqual(stray, [], `第 ${i + 1} 轮后子进程残留: ${stray.join(',')}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. terminate 与 target 自然退出同时发生
// ---------------------------------------------------------------------------

test('竞态：terminate 与 target 自然退出同时发生', { timeout: 180000, ...RACE }, async () => {
  // target 极短命（exit 0），terminate 也几乎同时到达。
  // 关键约束：**恰好一个终态结果**，不能既报 target-exit 又报 error。
  //
  // 用 setImmediate 让 terminate 尽可能贴近 start 写入的时刻 ——
  // 这是实测唯一能稳定触发「terminate 先于 start 被处理」分支的时序：
  //   普通 await sleep(0) 时 start 总是先被处理，走不到该分支。
  for (let i = 0; i < 20; i += 1) {
    const h = launchRunner('aot', { argv: ['cmd.exe', '/c', 'exit 3'] });
    setImmediate(() => h.terminate());

    const st = await h.wait(12000);
    assert.ok(st.result !== null, `第 ${i} 次: 未收到结果`);

    // runner 的 stdout 必须**恰好**一条终态行。
    // 重复投递会被 host 视为协议错误，也可能覆盖先前结果。
    // 注意用 protoRaw（完整原始行）而不是 proto（解析缓冲，读后即清空）——
    // 混用会让这条断言永远成立，形同虚设。
    assert.strictEqual(
      st.protoRaw.length,
      1,
      `第 ${i} 次: 应恰好 1 条终态结果，实际 ${st.protoRaw.length} 条: ${JSON.stringify(st.protoRaw)}`,
    );

    // 结果类型必须是已知的两种之一
    assert.ok(
      st.result.type === 'target-exit' || st.result.type === 'error',
      `第 ${i} 次: 未知结果类型 ${JSON.stringify(st.result)}`,
    );

    await sleep(100);
    await allGone([h.state.pid].filter(Boolean), `第 ${i} 次 runner`);
  }
});
