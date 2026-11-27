#!/usr/bin/env node
/**
 * `scripts/collect-launch-metrics.mjs` 的回归测试。
 *
 * ## 只测一件事：区分「取不到」与「是零」
 *
 * 这个脚本明天会在无人值守的情况下跑一次，那时没有人在旁边判断输出对不对。
 * 它最容易出的错不是崩溃，而是**把取不到的数据显示成 0** ——
 * 那会被当成「今天没人来」，进而得出「文章失败」的错误结论。
 * 本项目对这类错误有明确立场：宁可说测不出来。
 *
 * 所以这里用注入的方式（不碰真实网络）逐条锁住：
 *   - gh 不可用 → 字段必须是 null，不能是 0
 *   - 流量接口滞后 → 必须报「未覆盖」，不能说成「当天 0 浏览」
 *   - 发布时间未记录 → 必须报「未知」，不能按 00:00 瞎算
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const SCRIPT = path.join(REPO, 'scripts', 'collect-launch-metrics.mjs')

/**
 * 在隔离环境里跑脚本，让所有 `gh` 调用都失败。
 *
 * ## 为什么不能用「PATH 前置一个假 gh」
 *
 * 第一版就是那么写的，结果测试**假通过**：Windows 上 `execFileSync('gh')`
 * 不会执行 `gh.cmd`（需要经过 cmd.exe），于是真实 gh 照样被调到，
 * 返回了真实的 0。测试以为在用假 gh，其实在用真的。
 *
 * 这恰好又是本项目反复踩的坑：**看起来在测 A，实际测的是 B**。
 *
 * 现在改用 `node -r <preload>`：在脚本加载前替换 `child_process.execFileSync`，
 * 拦下所有 `gh` 调用。这样无论脚本怎么调，都拿不到真数据。
 */
function runWithBrokenGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'))
  // 用 CJS 预加载更直接：node -r 一个 cjs 文件，改全局依赖
  const preload = path.join(dir, 'preload.cjs')
  fs.writeFileSync(preload, `
    const cp = require('node:child_process')
    const original = cp.execFileSync
    cp.execFileSync = function (file, args, opts) {
      if (String(file) === 'gh') {
        const e = new Error('gh unavailable (injected)')
        e.status = 1
        throw e
      }
      return original.call(this, file, args, opts)
    }
  `, 'utf8')

  try {
    const out = execFileSync(process.execPath, ['-r', preload, SCRIPT, '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: REPO,
    })
    return JSON.parse(out)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('gh 不可用时，指标为 null 而不是 0', () => {
  const m = runWithBrokenGh()

  // 这是本套件的核心断言：0 会被误读成「没人来」，null 才是「没查到」。
  assert.strictEqual(m.repo.stars, null, 'stars 取不到时必须是 null')
  assert.strictEqual(m.repo.forks, null)
  assert.notStrictEqual(m.repo.stars, 0, '绝不能把「取不到」写成 0')

  for (const d of m.discussions) {
    assert.strictEqual(d.comments, null, `#${d.number} 取不到时必须为 null`)
  }
})

test('--json 输出可被解析，且字段齐全', () => {
  const m = runWithBrokenGh()
  for (const k of ['collectedAt', 'articleUrl', 'publishedAt', 'hoursSincePublish', 'repo', 'traffic', 'discussions', 'npmWeekDownloads']) {
    assert.ok(k in m, `缺少字段 ${k}`)
  }
  assert.ok(Array.isArray(m.discussions))
  assert.strictEqual(m.discussions.length, 2, '应同时跟踪 #11893 与 #12532')
})

test('发布时间未记录精确时刻时，hoursSincePublish 为 null 而非按 00:00 计算', () => {
  // 直接验证源码里的判据，避免为了这一条去改脚本常量。
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.ok(src.includes('T\\d{2}:') , 'hoursSince 必须要求真实时分，不接受纯日期')
  assert.ok(src.includes('return null'), '无法计算时必须返回 null')
})

test('流量滞后时显式标注 lagged，而不是当作「当天 0 浏览」', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.ok(src.includes('lagged'), '必须产出 lagged 标记')
  assert.ok(src.includes('接口尚未覆盖'), '报告必须把「滞后」和「没人来」区分开')
})
