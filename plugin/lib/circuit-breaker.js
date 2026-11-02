/**
 * 极简熔断器 —— 只做一件对的事
 *
 * ## 为什么需要它
 *
 * 把 runner 从 node 换成 AOT exe 之后，多了一类新的失败模式：
 * exe 被杀软隔离、被策略拦截、版本和 host 不匹配、依赖的系统 DLL 缺失。
 * 这些失败是**系统级**的 —— 一旦发生，**每一次**子进程调用都会失败，
 * 整个 DSH 会话直接不可用。
 *
 * 一个「性能优化」把可用性搞坏是不可接受的，所以需要自动降级。
 *
 * ## 设计取舍
 *
 * 刻意做得很小，因为熔断逻辑本身出 bug 比没有熔断更危险：
 *
 * - **只数连续失败**：成功一次就清零。不做滑动窗口、不做半开探测计时 ——
 *   那些都需要时间源和更多状态，是 bug 的温床。
 * - **不自动恢复**：熔断后需要显式 `reset()`。理由：如果失败原因是
 *   「exe 被隔离」，反复试探只会让每次调用都慢一拍（先失败再降级）。
 *   由调用方（或下次会话启动）决定何时重试。
 * - **不吞异常**：`recordFailure` 只记账，不改变控制流。
 */
export class CircuitBreaker {
  /** 连续失败次数 */
  #failures = 0;
  /** 是否已熔断 */
  #open = false;
  /** 触发阈值 */
  #threshold;
  #onOpen;
  #onClose;

  /**
   * @param {object} options
   * @param {number} options.threshold 连续失败多少次后熔断
   * @param {(reason: unknown) => void} [options.onOpen]  熔断回调
   * @param {() => void} [options.onClose]                恢复回调
   */
  constructor({ threshold, onOpen, onClose }) {
    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new Error(`CircuitBreaker: threshold 必须是正整数，收到 ${threshold}`);
    }
    this.#threshold = threshold;
    this.#onOpen = onOpen;
    this.#onClose = onClose;
  }

  /** 当前是否处于熔断（降级）状态 */
  get isOpen() {
    return this.#open;
  }

  /** 当前连续失败次数 */
  get failures() {
    return this.#failures;
  }

  /**
   * 记录一次失败。达到阈值时触发一次 `onOpen`（只触发一次）。
   *
   * @param {unknown} reason 用于日志的失败原因
   */
  recordFailure(reason) {
    this.#failures += 1;
    if (this.#open) return;
    if (this.#failures < this.#threshold) return;

    this.#open = true;
    this.#onOpen?.(reason);
  }

  /**
   * 记录一次成功。清零连续失败计数。
   *
   * 已经熔断时不自动恢复 —— 见文件头「设计取舍」。
   */
  recordSuccess() {
    this.#failures = 0;
  }

  /** 显式恢复：清零并关闭熔断。 */
  reset() {
    this.#failures = 0;
    if (!this.#open) return;
    this.#open = false;
    this.#onClose?.();
  }
}
