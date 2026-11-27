#!/usr/bin/env node
/**
 * 发布后 24h 指标采集。
 *
 * ## 这个脚本存在的理由
 *
 * 文章发布后最容易犯的判断错误，是**用单点快照判断成败**。
 * 本项目自己的测量纪律（`docs/测量方法论…md`）第一条就是这个：
 *
 *   「测之前先读被测物的调用契约」+
 *   「归因要多点采样，不能拿单次快照」
 *
 * 而「看 star 有没有涨」恰恰是最典型的单点快照 —— 它会同时误判两件事：
 *
 *   1. 掘金阅读量高度依赖推荐池分发，首日低 ≠ 文章不行
 *   2. star 转化率取决于「DSH 用户 ∩ Windows ∩ 在乎 100ms」这个极小交集，
 *      样本量根本不足以证明质量（11 个访客 0 个 star 在统计上说明不了任何事）
 *
 * 另一个陷阱刚刚实测确认：**GitHub 流量接口本身滞后约 1 天**。
 * 发布当天去查，最新一天的数据还是发布前一天 —— 此时「查不到」会被
 * 误读成「当天没人来」。脚本现在显式区分这两种情况。
 *
 * 所以本脚本采集的是**过程指标**而不是结果指标：
 *
 *   - 真正的瓶颈在「上游有没有被推动」→ 去数 discussion 的评论变化
 *   - 其次是「有没有人真的到达」→ GitHub 浏览/克隆的独立访客数
 *   - 最后才是 star（且必须与访客数一起看，否则无意义）
 *
 * ## 用法
 *
 *   node scripts/collect-launch-metrics.mjs              # 采集并打印
 *   node scripts/collect-launch-metrics.mjs --json       # 输出 JSON
 *   node scripts/collect-launch-metrics.mjs --save       # 追加到 docs/articles/publish/launch-metrics.jsonl
 *
 * ## 依赖
 *
 * `gh`（已认证）。缺失时对应字段为 null 而不是 0 —— **取不到不等于零**，
 * 这个区别是本项目所有门禁的一致立场。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const OUT = path.join(REPO, 'docs', 'articles', 'publish', 'launch-metrics.jsonl')

/** 本次发布的锚点。文章与 discussion 编号都写死，避免脚本自己去猜。 */
const LAUNCH = {
  articleUrl: 'https://juejin.cn/post/7712783109374869558',
  // 真实发布时刻。依据：回填提交 e2c903b 的时间是 22:04，发布应略早于此。
  // 若日后不确定，改成 null —— 脚本会显示「未知」，而不是按 00:00 瞎算。
  articlePublishedAt: '2026-11-27T22:00:00+08:00',
  discussions: [11893, 12532],
  repo: 'boyingliu01/dsh-aot-runner',
  upstream: 'deepseek-ai/deepseek-harness',
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 }).trim()
  } catch (e) {
    return null
  }
}

function ghJson(args) {
  const raw = gh(args)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 仓库级指标。取不到时返回 null，不要用 0 冒充。 */
function collectRepo() {
  const r = ghJson(['api', `repos/${LAUNCH.repo}`, '--jq',
    '{stars: .stargazers_count, forks: .forks_count, watchers: .subscribers_count}'])
  return r ?? { stars: null, forks: null, watchers: null }
}

/**
 * GitHub 流量。只保留 14 天窗口的汇总 + 发布当日的分项。
 *
 * 分项很重要：如果发布日的 views 没有明显高于前几日，
 * 说明「文章 → 仓库」这条链路没打通，而不是「文章没价值」。
 */
function collectTraffic() {
  const views = ghJson(['api', `repos/${LAUNCH.repo}/traffic/views`])
  const clones = ghJson(['api', `repos/${LAUNCH.repo}/traffic/clones`])
  if (views === null && clones === null) {
    return { views: null, clones: null, publishDayViews: null }
  }
  const pick = (payload) => {
    if (!payload || !Array.isArray(payload.views ?? payload.clones)) {
      return payload && typeof payload.count === 'number'
        ? { total: payload.count, uniques: payload.uniques }
        : null
    }
    const rows = payload.views ?? payload.clones
    // 时间戳是 UTC 日（形如 2026-11-26T00:00:00Z），发布日按 +08:00 算。
    // 直接用字符串前缀匹配会在跨时区时错位，所以显式换算。
    const publishDayUtc = LAUNCH.articlePublishedAt
      ? new Date(LAUNCH.articlePublishedAt).toISOString().slice(0, 10)
      : null
    const day = publishDayUtc
      ? rows.find((v) => v.timestamp.startsWith(publishDayUtc))
      : null
    // GitHub 流量接口有约一天的延迟：发布日当天通常还查不到。
    // 这里把「滞后」显式报出来，避免读者把「查不到」当成「当天没人来」。
    const latest = rows.length > 0 ? rows[rows.length - 1].timestamp.slice(0, 10) : null
    return {
      total: payload.count ?? null,
      uniques: payload.uniques ?? null,
      publishDay: day ? { count: day.count, uniques: day.uniques } : null,
      latestDayInApi: latest,
      lagged: publishDayUtc !== null && latest !== null && latest < publishDayUtc,
    }
  }
  const v = pick(views)
  const c = pick(clones)
  return { views: v, clones: c, publishDayViews: v?.publishDay?.count ?? null }
}

/**
 * 上游 discussion 的评论数 —— 这是**本项目真正的瓶颈指标**。
 *
 * 为什么它比 star 重要：项目的唯一硬阻塞是上游不修，而「修」需要维护者注意到。
 * 评论数增加（尤其是来自不同账号的）说明注意力在汇聚；
 * star 增加但评论不动，说明只是路过，阻塞一点没动。
 */
function collectDiscussions() {
  const parts = LAUNCH.discussions.map((n) =>
    `d${n}: discussion(number: ${n}) { comments { totalCount } }`).join(' ')
  const q = `query { repository(owner: "${LAUNCH.upstream.split('/')[0]}", name: "${LAUNCH.upstream.split('/')[1]}") { ${parts} } }`
  const r = ghJson(['api', 'graphql', '-f', `query=${q}`])
  if (r === null) return LAUNCH.discussions.map((n) => ({ number: n, comments: null }))
  const repo = r.data?.repository ?? {}
  return LAUNCH.discussions.map((n) => ({
    number: n,
    comments: repo[`d${n}`]?.comments?.totalCount ?? null,
  }))
}

/**
 * npm 下载量。仅作参考 —— 影响力诊断已经证明这个数字主要是镜像/爬虫
 * （日均 45 次下载 vs 每天 < 1 次仓库浏览）。**不要把它当用户数。**
 */
function collectNpm() {
  try {
    const out = execFileSync('curl', [
      '-fsSL', '--ssl-no-revoke', '--max-time', '30',
      'https://api.npmjs.org/downloads/point/last-week/@boyingliu01/dsh-aot-runner',
    ], { encoding: 'utf8', timeout: 40_000 }).trim()
    return JSON.parse(out).downloads ?? null
  } catch {
    return null
  }
}

function collect() {
  return {
    collectedAt: new Date().toISOString(),
    articleUrl: LAUNCH.articleUrl,
    publishedAt: LAUNCH.articlePublishedAt,
    hoursSincePublish: hoursSince(LAUNCH.articlePublishedAt),
    repo: collectRepo(),
    traffic: collectTraffic(),
    discussions: collectDiscussions(),
    npmWeekDownloads: collectNpm(),
  }
}

/**
 * 距发布过了多久。
 *
 * ⚠️ 不能用「发布日 00:00」当前提 —— 实际是傍晚发的，
 * 按 00:00 算会把 22 小时说成「已过一天」，直接误导「该不该看数据了」的判断。
 * 所以只接受**真实时分**（ISO 带时间）；拿不到就返回 null，
 * 宁可显示「未知」也不给一个错的方向。
 */
function hoursSince(publishedAt) {
  if (!publishedAt || !/T\d{2}:\d{2}/.test(publishedAt)) return null
  const then = new Date(publishedAt).getTime()
  if (Number.isNaN(then)) return null
  return Math.round((Date.now() - then) / 3_600_000)
}

/** 把数字安全地格式化成显示用的字符串。null 要显示成「取不到」，不是 0。 */
function fmt(v) {
  if (v === null || v === undefined) return '取不到'
  return String(v)
}

function printReport(m) {
  console.log('发布后指标')
  console.log('─'.repeat(56))
  console.log(`采集时间      ${m.collectedAt}`)
  console.log(`发布距现在    ${m.hoursSincePublish === null ? '未知（未记录精确发布时刻）' : `${m.hoursSincePublish} 小时`}`)
  console.log('')
  console.log('【真正的瓶颈指标】上游 discussion 评论数')
  for (const d of m.discussions) {
    console.log(`  #${d.number}  ${fmt(d.comments)} 条`)
  }
  console.log('')
  console.log('【到达指标】GitHub 流量（14 天窗口）')
  if (m.traffic.views) {
    console.log(`  浏览  总计 ${fmt(m.traffic.views.total)} / 独立 ${fmt(m.traffic.views.uniques)}`)
    if (m.traffic.views.publishDay) {
      console.log(`  发布当日 ${m.traffic.views.publishDay.count} / 独立 ${m.traffic.views.publishDay.uniques}`)
    } else if (m.traffic.views.lagged) {
      // 「查不到」和「当天没人来」是两件事，不能混。
      console.log(`  发布当日 接口尚未覆盖（最新只到 ${fmt(m.traffic.views.latestDayInApi)}，GitHub 流量约滞后 1 天）`)
    }
  } else {
    console.log('  浏览  取不到（需要有 push 权限的 token）')
  }
  if (m.traffic.clones) {
    console.log(`  克隆  总计 ${fmt(m.traffic.clones.total)} / 独立 ${fmt(m.traffic.clones.uniques)}`)
  }
  console.log('')
  console.log('【结果指标】仓库（必须与上面的访客数一起看）')
  console.log(`  star ${fmt(m.repo.stars)} / fork ${fmt(m.repo.forks)} / watcher ${fmt(m.repo.watchers)}`)
  console.log('')
  console.log(`【参考，非用户数】npm 近 7 天下载 ${fmt(m.npmWeekDownloads)}`)
  console.log('')
  console.log('─'.repeat(56))
  console.log('判读提醒：')
  console.log('  · star 0 且访客 < 50 → 样本不足，不能据此判断文章质量')
  console.log('  · 浏览涨但 discussion 评论不涨 → 只是路过，阻塞未动')
  console.log('  · npm 下载数不可当用户数（已证实主要是镜像/爬虫）')
}

function main() {
  const argv = process.argv.slice(2)
  const m = collect()

  if (argv.includes('--json')) {
    console.log(JSON.stringify(m, null, 2))
    return
  }
  printReport(m)

  if (argv.includes('--save')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.appendFileSync(OUT, `${JSON.stringify(m)}\n`)
    console.log('')
    console.log(`已追加到 ${path.relative(REPO, OUT)}`)
  }
}

main()
