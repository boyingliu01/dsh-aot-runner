/**
 * 测试共享工具。
 *
 * ## 为什么需要这个文件
 *
 * leak-verify / race-verify 各自复制了一套 sleep 和 waitUntil，内容逐字节相同。
 * xp-gate Gate 2（重复代码检测）把这识别为克隆。
 *
 * 复制本身不算大错，但它让「改进一处工具函数」变成「得记得改 N 个文件」。
 *
 * ## 范围约定
 *
 * 这里只放**纯工具**（无断言、无测试语义）。断言留在各自测试里，
 * 因为不同测试对「失败」的表述需求不同。
 *
 * 进程相关的工具（isAlive / alivePids / listDescendantPids）**不放在这里** ——
 * runner-client.js 里已有一份经过实测校准的实现，再从别处引一份必然分叉。
 */

'use strict';

/** 等待若干毫秒。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询直到条件成立或超时。
 *
 * 进程回收是异步的：Job close 到内核真正清理进程有微小延迟，
 * 固定 sleep 要么不够稳、要么拖慢测试，所以用轮询。
 *
 * @param {() => boolean} pred 条件
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<boolean>} 最后一次判定的结果
 */
async function waitUntil(pred, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(intervalMs);
  }
  return pred();
}

module.exports = { sleep, waitUntil };
