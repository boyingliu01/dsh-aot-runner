// 契约覆盖率棘轮的门禁判定 —— **纯函数，不做 I/O**。
//
// 为什么要单独成模块：判定逻辑是这个门禁唯一会被反复怀疑的部分
// （「凭什么说它退步了」「凭什么说它没测到」），把它做成纯函数
// 才能在不跑 17 秒采集的前提下逐条测边界。
// 采集与落盘留在 contract-branch-coverage.mjs。
//
// ## 四态退出码（与 report / 其它 check 脚本的区别）
//
//   0  PASS          未回退
//   1  REGRESSED     回退（真该补测试了）
//   3  UNMEASURED    没测到（环境问题：找不到契约源 / 采集驱动崩了）
//   4  BASELINE_STALE 基线缺失或过期（门禁自身的缺陷：契约变了没重采）
//
// 为什么 3 与 4 必须分开：它们的补救方向**相反**。
// 3 是「换个环境重跑」，4 是「跑 --update 重采基线」。
// 合并成一个码，CI 就只能笼统地红，人还得点进去猜。
//
// 为什么不用 2：2 在本仓库其它脚本里没有约定，3/4 直接跳过它
// 是为了让「非 0 且非 1」这一族一眼可辨。
//
// ## 判据为什么是比率而不是绝对计数
//
// 实测同一契约版本连跑，ranges.covered 在 42/43/44、ranges.total 在 156/159 之间抖。
// 只比 covered 的绝对值会同时出现两种错：
//   漏报：covered 从 44 掉到 43，但 total 从 159 掉到 100 —— 覆盖率其实大跌，
//         绝对计数却可能仍然「没低于基线 - 容差」。
//   误报：total 涨了，covered 没涨，绝对计数看着没退步，比率其实降了（反之亦然）。
// 所以主判据用比率（整数百分点 ×100，即 ratioPp），另给 total 一个下限，
// 挡住「分母塌缩把比率做高」这种伪造。

/** 判定结果。 */
export const VERDICT = {
  PASS: 'PASS',
  REGRESSED: 'REGRESSED',
  UNMEASURED: 'UNMEASURED',
  BASELINE_STALE: 'BASELINE_STALE',
};

/** 判定 → 退出码。 */
export const EXIT_CODE = {
  [VERDICT.PASS]: 0,
  [VERDICT.REGRESSED]: 1,
  [VERDICT.UNMEASURED]: 3,
  [VERDICT.BASELINE_STALE]: 4,
};

// ---- 标定常量 ----
//
// 这两个数字是**实测标定值，不是随手定的阈值**，依据：
//   连续多次运行 (42..44)/(156..159) → 比率区间 26.92%~28.21%，极差 1.29pp
//      → 容差取 2.00pp（极差 + 0.7 余量）
//   ranges.total 极差 3 → 分母下限取 3
// 契约面（DSH 版本）变化后必须重新标定。
// 基线里存了 contractSha256：一旦契约变了就判 BASELINE_STALE 并强制 --update，
// 这一步顺带逼着重新标定。没有这个绑定，这两个数字迟早变成
// 「谁也不敢改、也说不清依据」的死数字。

/** 比率容差，单位为「百分点 ×100」。200 = 2.00pp。 */
export const RANGE_RATIO_TOLERANCE_PP100 = 200;

/** ranges.total 允许的最大缩水（防分母塌缩）。 */
export const RANGE_TOTAL_TOLERANCE = 3;

/**
 * 这两个容差是**从哪次实测推出来的**。
 *
 * 为什么要写进基线：容差是这套门禁里唯一会**静默过期**的东西。
 * `contractSha256` 只保证「契约变了就重采基线」，但重采时如果人只是
 * 抄了新的覆盖率数字，两个容差会**原封不动地留在常量里** ——
 * 它们描述的却已经是另一份契约的抖动特性了。
 *
 * 所以基线里额外记下这次的标定输入。`--update` 时若发现标定输入与
 * 基线记录的不一致（契约规模变了），会**拒绝静默继续**，要求重新推导。
 * 这不是自动推导（那需要多次采样，成本高且不该在门禁路径上做），
 * 而是「不允许悄悄沿用」。
 */
export const CALIBRATION = {
  /** 实测抖动极差（百分点 ×100），2026-11-25 在 DSH 0.2.0-rc.2 上测 5 次。 */
  observedJitterSpanPp100: 129,
  /**
   * 实测 ranges.total 极差。
   *
   * 注意：这里与 `RANGE_TOTAL_TOLERANCE` 是**恰好相等**（3 = 3），零余量。
   * 也就是说正常抖动的上界正好等于判塌缩的门槛 —— 一旦某次采样抖到 4，
   * 就会误报。
   *
   * 之所以维持相等而不再放大：实测 total 极差就是 3（156 与 159 两个值），
   * 把它调到 4 会让「真正的分母塌缩」多出 1 的盲区，而这是这条判据唯一的
   * 用途。零余量在这里不是疏忽，而是「宁可误报也要抓住」的取舍。
   *
   * 但这意味着**契约面变化时必须重新测**，`calibrationProblems()` 会在
   * 不一致时报警，`--update` 会在契约规模变化时显式提示。
   */
  observedTotalSpan: 3,
  /** 容差 = 极差 + 余量，余量不得小于极差的 50%，避免「刚好等于抖动」的脆弱取值。 */
  marginPp100: RANGE_RATIO_TOLERANCE_PP100 - 129,
  /** 测量依据：契约文件名 + 采集次数，便于将来复核。 */
  measuredOn: '2026-11-25',
  samples: 5,
};

/**
 * 校验当前容差是否仍是「有一条实测依据」的取值。
 *
 * 判据不追求「算出最优值」，只追求：**改了容差就得改这份记录**。
 * 否则就会出现「半年后没人知道 2.00pp 是哪来的」这种死数字。
 *
 * @returns {string[]} 问题清单，空表示自洽
 */
export function calibrationProblems() {
  const problems = [];
  const minMargin = Math.ceil(CALIBRATION.observedJitterSpanPp100 * 0.5);
  if (CALIBRATION.marginPp100 < minMargin) {
    problems.push(
      `比率容差余量过小：余量 ${CALIBRATION.marginPp100} < 极差的 50%（${minMargin}）。` +
        '容差贴近实测抖动会变成抛硬币，请补充采样后重新标定。',
    );
  }
  if (RANGE_RATIO_TOLERANCE_PP100 !== CALIBRATION.observedJitterSpanPp100 + CALIBRATION.marginPp100) {
    problems.push(
      `容差(${RANGE_RATIO_TOLERANCE_PP100}) ≠ 实测极差(${CALIBRATION.observedJitterSpanPp100})` +
        ` + 余量(${CALIBRATION.marginPp100})。改了容差就要同步改 CALIBRATION，` +
        '否则记录与实际不符。',
    );
  }
  if (CALIBRATION.observedTotalSpan > RANGE_TOTAL_TOLERANCE) {
    problems.push(
      `分母下限(${RANGE_TOTAL_TOLERANCE}) 小于实测 total 极差(${CALIBRATION.observedTotalSpan})，` +
        '正常抖动就会被判塌缩。',
    );
  }
  return problems;
}

/** 采集驱动成功时应为 true；任何其它值都按「没测成」处理。 */
function isMeasured(report) {
  return report?.collectOk === true;
}

/**
 * 比率，单位为百分点 ×100 的整数。
 *
 * 用整数而非浮点是刻意的：判定里要做「刚好等于边界」的比较，
 * 浮点会让 200/20000 与 201/20000 这类边界出现 `0.1+0.2 !== 0.3` 式的不确定。
 * ratioPp = round(covered / total * 10000)，即 28.21% → 2821。
 */
export function rangeRatioPp(ranges) {
  const total = ranges?.total ?? 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round(((ranges.covered ?? 0) / total) * 10000);
}

/**
 * 从一次测量结果抽出基线要记的字段。
 *
 * 只记**稳定可比**的量：契约身份（版本/文件名/内容哈希）与三项计数。
 * 不记 contractFiles 的时间戳之类每次都会变的东西 —— 基线进版本库，
 * 每次 `--update` 都产生无意义 diff 会让人开始不看它的 diff。
 */
export function baselineFrom(report, { dshVersion, contractSha256, capturedAt }) {
  const r = report.runtime.ranges;
  return {
    dshVersion,
    contractFile: report.contractFiles[0],
    contractSha256,
    capturedAt,
    // 记下容差是照着哪个契约面标定的。契约变了而这两项没跟着重推，
    // 将来没人能说清 2.00pp 是怎么来的。
    calibration: {
      contractStatic: report.static.total,
      ratioTolerancePp100: RANGE_RATIO_TOLERANCE_PP100,
      totalTolerance: RANGE_TOTAL_TOLERANCE,
      observedJitterSpanPp100: CALIBRATION.observedJitterSpanPp100,
      observedTotalSpan: CALIBRATION.observedTotalSpan,
      measuredOn: CALIBRATION.measuredOn,
      samples: CALIBRATION.samples,
    },
    static: report.static.total,
    functions: {
      covered: report.runtime.functions.covered,
      total: report.runtime.functions.total,
    },
    ranges: {
      covered: r.covered,
      total: r.total,
      ratioPp: rangeRatioPp(r),
    },
    uncoveredFunctions: report.runtime.uncoveredFunctions.filter((n) => !n.startsWith('<')),
  };
}

/**
 * 一组「字段对不上就算过期」的检查，用**数据**表达而不是 if 链。
 *
 * 写成表的好处不只是降 CCN：新增一条检查时只需加一行，
 * 不必再读一遍整个函数确认有没有漏掉「problems.length > 0 才追加总结」这类细节。
 * 每个检查返回 null（一致）或一句人话（不一致）。
 */
function collectProblems(checks) {
  return checks.map((check) => check()).filter((msg) => msg !== null);
}

/**
 * 基线记录的标定参数是否与当前常量脱节。
 *
 * 为什么单独判：`calibrationProblems()` 只检查「常量自身是否自洽」，
 * 它看不见基线里那份旧记录。改了常量却没重跑 `--update` 时，
 * 常量自洽、基线也自洽，但**两者描述的不是同一件事**。
 * 这属于「基线过期」（要重采），不是「覆盖回退」（要补测试）。
 */
function calibrationDrift(baseline) {
  const c = baseline.calibration;
  if (!c) return []; // 老基线没有该段：不强行判过期，交给正常流程

  const problems = collectProblems([
    () =>
      c.ratioTolerancePp100 === RANGE_RATIO_TOLERANCE_PP100
        ? null
        : `基线记录的比率容差 ${c.ratioTolerancePp100 / 100}pp 与当前常量 ${fmt(RANGE_RATIO_TOLERANCE_PP100)}pp 不一致`,
    () =>
      c.totalTolerance === RANGE_TOTAL_TOLERANCE
        ? null
        : `基线记录的分母容差 ${c.totalTolerance} 与当前常量 ${RANGE_TOTAL_TOLERANCE} 不一致`,
    () =>
      c.observedJitterSpanPp100 === CALIBRATION.observedJitterSpanPp100
        ? null
        : `基线记录的实测极差 ${c.observedJitterSpanPp100} 与当前标定 ${CALIBRATION.observedJitterSpanPp100} 不一致`,
  ]);

  // 只在真有脱节时才追加这条总结，否则会凭空多出一条「问题」。
  if (problems.length > 0) {
    problems.push('容差常量改了但基线没重采 —— 重跑 --update 让基线带上新标定依据。');
  }
  return problems;
}

/** 契约身份是否与基线一致。 */
function identityProblems(report, baseline, currentSha256) {
  const file = report.contractFiles?.[0];
  return collectProblems([
    () =>
      !baseline.contractFile || file === baseline.contractFile
        ? null
        : `契约文件名变了：基线 ${baseline.contractFile} → 当前 ${file}`,
    () =>
      !baseline.contractSha256 || !currentSha256 || currentSha256 === baseline.contractSha256
        ? null
        : `契约文件内容变了：基线 sha256 ${baseline.contractSha256.slice(0, 12)}… → 当前 ${currentSha256.slice(0, 12)}…`,
    () =>
      !baseline.dshVersion || baseline.dshVersion === report.dshVersion
        ? null
        : `DSH 版本变了：基线 ${baseline.dshVersion} → 当前 ${report.dshVersion}`,
  ]);
}

/**
 * 判断一次测量相对基线是否回退。
 *
 * @param {object} report 采到的覆盖率报告（须含 collectOk / static / runtime / contractFiles）
 * @param {object|null} baseline 基线内容；null 表示基线文件不存在
 * @param {object} [identity] 当前契约的身份
 * @param {string} [identity.dshVersion]
 * @param {string} [identity.contractSha256]
 * @returns {{verdict: string, exitCode: number, reasons: string[], baseline?: object}}
 */
/**
 * 判定分三步，每步只回答一个问题。
 *
 * 拆开不是为了「看着整齐」，是因为合并写时 CCN 到 16 —— 而这三步是
 * **三种完全不同的失败**（没测到 / 基线过期 / 真回退），混在一个函数里
 * 会让「哪条判据在什么前提下才成立」变得需要通读全文才能确认。
 */
export function judge(report, baseline, identity = {}) {
  // 三步**顺序敏感**，不能换位置：
  //   1. 没测到 → 根本没有可比的数字
  //   2. 基线不能比 → 有数字也没有可信的参照
  //   3. 才轮到「真的退步了吗」
  // 顺序反了会把「没测到」或「基线过期」误报成「覆盖率下降」，
  // 把人赶到补测试这个错误方向上去。
  const steps = [
    () => {
      const why = unmeasurableReason(report);
      return why ? result(VERDICT.UNMEASURED, [why]) : null;
    },
    () =>
      baseline
        ? null
        : result(VERDICT.BASELINE_STALE, ['基线文件不存在']),
    () => {
      const stale = baseline ? stalenessReasons(report, baseline, identity) : [];
      return stale.length > 0 ? result(VERDICT.BASELINE_STALE, stale, baseline) : null;
    },
    () => {
      if (!baseline) return null;
      const regressions = regressionReasons(report, baseline);
      return regressions.length > 0 ? result(VERDICT.REGRESSED, regressions, baseline) : null;
    },
  ];

  for (const step of steps) {
    const verdict = step();
    if (verdict) return verdict;
  }
  return result(VERDICT.PASS, [], baseline);
}

/**
 * 「这次测量本身是否成立」—— 不成立就没有任何结论可比。
 *
 * 必须最先判：否则一次空报告会被当成「覆盖率掉了」，把人赶到错的方向上
 * 去补测试。这正是本仓库反复强调的「没测得 ≠ 测得为零」。
 *
 * @returns {string|null} 不成立的原因；成立则 null
 */
/** 某个计数是否「有值且为正」—— 0 和 undefined 都意味着没测到。 */
function isPositive(n) {
  return Number.isFinite(n) && n > 0;
}

function unmeasurableReason(report) {
  if (!isMeasured(report)) {
    return '采集驱动非零退出或超时，这次的数字来自一次不完整的采集';
  }
  if (!isPositive(report.static?.total)) {
    return '静态分支数为 0，说明没找到契约文件或解析失效';
  }
  if (!isPositive(report.runtime?.ranges?.total)) {
    return '运行时区间总数为 0，说明采集没采到契约文件';
  }
  return null;
}

/**
 * 「这份基线还能不能用来比」—— 不能比就该重采，而不是判回退。
 *
 * 两类原因：契约身份变了（DSH 升级），或容差常量与基线里的标定记录脱节
 * （有人改了 CALIBRATION 却没重跑 --update）。
 */
function stalenessReasons(report, baseline, identity) {
  // 契约变了就不算「回退」：分支总数本来就会跟着契约规模走。
  const drift = identityProblems(report, baseline, identity.contractSha256);
  if (drift.length > 0) return drift;

  // 基线里的标定记录必须与当前常量一致。否则会出现「有人改了 CALIBRATION
  // 但没重跑 --update」—— 此时 calibrationProblems() 依然自洽（它只看常量），
  // 而基线里那份旧记录已经失真，下一个读基线的人会被它误导。
  return calibrationDrift(baseline);
}

/**
 * 「相对于一份有效的基线，这次确实退步了吗」。
 *
 * 每条判据的容差不同，因为它们描述的东西稳定性不同：
 *   · 静态分支数：契约的固有规模，实测完全一致 → 精确比对
 *   · 函数覆盖数：实测稳定 → 精确比对
 *   · 区间总数：会抖 → 给下限
 *   · 比率：抖得最多 → 给容差
 */
function regressionReasons(report, baseline) {
  const reasons = [];

  if (report.static.total < baseline.static) {
    reasons.push(`静态分支数下降：基线 ${baseline.static} → 当前 ${report.static.total}`);
  }

  const fn = report.runtime.functions;
  if (fn.covered < baseline.functions.covered) {
    reasons.push(`已覆盖函数数下降：基线 ${baseline.functions.covered} → 当前 ${fn.covered}`);
  }

  // 注意别把局部变量取成与函数同名（ratioReason）—— 那会遮蔽函数，
  // 变成 `const ratioReason = ratioReason(...)` 的自我引用，运行期 TypeError。
  const tooFew = denominatorReason(report.runtime.ranges, baseline.ranges);
  if (tooFew) reasons.push(tooFew);

  const ratioDrop = ratioReason(report.runtime.ranges, baseline.ranges);
  if (ratioDrop) reasons.push(ratioDrop);

  return reasons;
}

/**
 * 分母下限：挡住「区间总数塌缩把比率做高」。
 *
 * 单靠比率判据会放过这种伪造 —— 13/40 = 32.5% 比基线 28% 还「高」。
 */
function denominatorReason(ranges, baselineRanges) {
  const floor = baselineRanges.total - RANGE_TOTAL_TOLERANCE;
  if (ranges.total >= floor) return null;
  return (
    `运行时区间总数塌缩：基线 ${baselineRanges.total} → 当前 ${ranges.total}` +
    `（容差 ${RANGE_TOTAL_TOLERANCE}）—— 分母变小会让比率虚高，所以单独判`
  );
}

/**
 * 主判据：比率。
 *
 * 调用方可能已经用重采中位数覆盖了 ratioPp（抖动只发生在 ratioPp 上），
 * 有覆盖值就以它为准；covered/total 保持真实值，供上面两条判据使用。
 */
function ratioReason(ranges, baselineRanges) {
  const current = Number.isFinite(ranges.ratioPp) ? ranges.ratioPp : rangeRatioPp(ranges);
  const floor = baselineRanges.ratioPp - RANGE_RATIO_TOLERANCE_PP100;
  if (current >= floor) return null;
  return (
    `分支区间覆盖率下降：基线 ${fmt(baselineRanges.ratioPp)}% → 当前 ${fmt(current)}%` +
    `（下限 ${fmt(floor)}%，已扣除 ${fmt(RANGE_RATIO_TOLERANCE_PP100)} 个百分点容差）`
  );
}

function result(verdict, reasons, baseline) {
  return { verdict, exitCode: EXIT_CODE[verdict], reasons, baseline };
}

/** ratioPp（百分点 ×100）→ 人读的百分比字符串。 */
export function fmt(ratioPp) {
  return (ratioPp / 100).toFixed(2);
}

/**
 * 多次重采的中位数 —— 用来吸收抖动。
 *
 * 规则刻意**偏保守**：
 *   · 取中位数；奇数个样本时中位数天然是中间那个。
 *   · 偶数个样本并列时取**较小**值。
 * 因此「2 次低 1 次高」会落到低值 → 判回退。
 * 反方向也一样（2 次高 1 次低 → 低值），所以**改进永远不会被虚报**。
 * 宁可多问一句「是真退步吗」，也不放过一次真实退步。
 *
 * @param {number[]} values
 */
export function conservativeMedian(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.floor((xs.length - 1) / 2)];
}
