#!/usr/bin/env node
/**
 * `scripts/backfill-article-links.mjs` 的回归测试。
 *
 * ## 这个脚本为什么值得一条测试
 *
 * 它存在的理由，是项目**已经复现过四次**的失败模式：「做完 90%，停在最后 10%」。
 * 而「回填链接」这一步本身就是这种模式的最新一环 —— 如果脚本本身坏了，
 * 失败方式会是**静默的**：文章已发布、仓库里却仍写着「待发布」，
 * 没有任何报错，和之前四次一模一样。
 *
 * 所以这里逐条锁住判定行为，尤其是**拒绝**的几种情况：
 * 宁可不写，也不要写进一个假 URL。
 *
 * 测试用临时副本，不碰仓库真实文件。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const SCRIPT = path.join(REPO, 'scripts', 'backfill-article-links.mjs')

/** 在临时目录里搭一份最小可用的仓库骨架，避免污染真实文件。 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'articles'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'backfill-article-links.mjs'))

  fs.writeFileSync(
    path.join(dir, 'docs', 'articles', '2026-11-26-我的基准测试说我的代码慢了20ms.md'),
    '# 标题\n\n> **状态**：待发布（2026-11-26 起草）。\n\n正文\n',
  )
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# 项目\n\n| 项 | 路径 |\n|---|---|\n| 发布稿 | `docs/articles/2026-11-26-我的基准测试说我的代码慢了20ms.md` |\n',
  )
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [0.2.8]\n\n- 内容\n')
  return dir
}

function run(dir, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'backfill-article-links.mjs'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

test('未回填时 --check 退出码为 1', () => {
  const dir = makeSandbox()
  const r = run(dir, ['--check'])
  assert.strictEqual(r.code, 1, '未回填必须失败，否则门禁等于没有')
  assert.match(r.out, /待发布/)
})

test('缺少 --url 时拒绝执行', () => {
  const dir = makeSandbox()
  const r = run(dir, [])
  assert.strictEqual(r.code, 1)
  assert.match(r.out, /缺少 --url/)
})

test('占位符 URL 被拒绝写入', () => {
  const dir = makeSandbox()
  // 这一条最重要：如果允许写入 example.com，门禁会「通过」但链接是死的。
  for (const bad of ['https://example.com/x', 'https://x.com/xxxx', 'not-a-url']) {
    const r = run(dir, ['--url', bad])
    assert.strictEqual(r.code, 1, `${bad} 应被拒绝`)
  }
  const article = fs.readFileSync(
    path.join(dir, 'docs', 'articles', '2026-11-26-我的基准测试说我的代码慢了20ms.md'),
    'utf8',
  )
  assert.match(article, /待发布/, '拒绝之后文件不应被改动')
})

test('--dry-run 不写文件', () => {
  const dir = makeSandbox()
  const before = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
  const r = run(dir, ['--url', 'https://juejin.cn/post/123', '--dry-run'])
  assert.strictEqual(r.code, 0)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), before)
})

test('回填后 --check 通过，且重复执行幂等', () => {
  const dir = makeSandbox()
  const url = 'https://juejin.cn/post/7234567890123456789'

  assert.strictEqual(run(dir, ['--url', url]).code, 0)
  assert.strictEqual(run(dir, ['--check']).code, 0, '回填后门禁应通过')

  const articlePath = path.join(dir, 'docs', 'articles', '2026-11-26-我的基准测试说我的代码慢了20ms.md')
  const snap = {
    article: fs.readFileSync(articlePath, 'utf8'),
    readme: fs.readFileSync(path.join(dir, 'README.md'), 'utf8'),
    changelog: fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
  }
  assert.ok(snap.article.includes(url), '文章状态行应含链接')
  assert.ok(snap.readme.includes(url), 'README 应补外链')
  assert.ok(snap.changelog.includes(url), 'CHANGELOG 应追加条目')

  // 第二条命令的幂等性：这是脚本最容易写坏的地方（重复追加 CHANGELOG）。
  assert.strictEqual(run(dir, ['--url', url]).code, 0)
  assert.strictEqual(fs.readFileSync(articlePath, 'utf8'), snap.article, '重复执行不应改动文章')
  assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), snap.readme, '重复执行不应改动 README')
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
    snap.changelog,
    '重复执行不应重复追加 CHANGELOG',
  )
})
