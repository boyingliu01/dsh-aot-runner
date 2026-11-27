#!/usr/bin/env node
/**
 * 发布后回填：把长文链接写回仓库各处。
 *
 * ## 为什么需要这个脚本
 *
 * 本项目的失败模式不是「做不出来」，是「做完了 90%，停在最后 10%」——
 * 已经复现过四次：
 *
 *   1. #21 修复写好、验证通过，**没提交没安装**
 *   2. 0.2.5~0.2.8 构建好、测试全绿，**没发 npm**（压了 4 个版本）
 *   3. `vendor/` 补丁锚点在 DSH 升级后失效，**没人发现**
 *   4. 长文写完、英译完、封面做好、指南写好，**没发**
 *
 * 第 4 条的「最后 10%」是：发布之后要把链接回填到 README、文章状态行、wiki。
 * 这一步如果靠手改，很容易忘——忘了之后，读者看到的还是「待发布」。
 *
 * 所以把这一步做成**一条命令**：
 *
 *   node scripts/backfill-article-links.mjs --url https://juejin.cn/post/xxxx
 *
 * 它会改这几处（幂等，重复跑不会写坏）：
 *   - 文章正文里的「状态：待发布」→「已发布：<url>」
 *   - README 的「先读哪一篇」表里，给发布稿补上外链
 *   - CHANGELOG 追加一条
 *
 * ## 用法
 *
 *   node scripts/backfill-article-links.mjs --url <文章URL>          # 回填
 *   node scripts/backfill-article-links.mjs --url <URL> --dry-run    # 只看会改什么
 *   node scripts/backfill-article-links.mjs --check                  # 检查是否已回填
 *
 * `--check` 的退出码：0 = 已回填 / 1 = 未回填（可以直接放进 CI 或 pre-push）。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REPO = path.resolve(__dirname, '..')

/** 长文正文（中文首发稿）。状态行在第 7 行附近。 */
const ARTICLE = path.join(REPO, 'docs', 'articles', '2026-11-26-我的基准测试说我的代码慢了20ms.md')
const README = path.join(REPO, 'README.md')
const CHANGELOG = path.join(REPO, 'CHANGELOG.md')

/** 「待发布」的多种可能写法，都要能命中 —— 否则脚本会静默什么也不做。 */
const PENDING_PATTERNS = [
  /^>\s*\*\*状态\*\*：待发布.*$/m,
  /^>\s*\*\*状态\*\*:\s*待发布.*$/m,
]

function parseArgs(argv) {
  const out = { url: null, dryRun: false, check: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--check') out.check = true
    else if (a === '--url') {
      out.url = argv[i + 1]
      i += 1
    }
  }
  return out
}

function assertUrl(url) {
  if (!url) {
    fail('缺少 --url <文章URL>')
  }
  if (!/^https?:\/\//.test(url)) {
    fail(`--url 必须是 http(s) 开头的绝对地址，收到: ${url}`)
  }
  // 掘金/知乎/V2EX 都行，但必须是一个真实可点的地址，不能是占位符。
  if (/example\.(com|org)|xxxx|TODO|<.*>/.test(url)) {
    fail(`--url 看起来是占位符，拒绝写入: ${url}`)
  }
}

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

function read(p) {
  if (!fs.existsSync(p)) fail(`文件不存在: ${p}`)
  return fs.readFileSync(p, 'utf8')
}

/**
 * 判断长文是否已经回填过。
 *
 * 判据：状态行里出现一个 http(s) 链接。
 * 不判「不等于待发布」—— 因为可能被改成别的措辞但仍没链接，那样等于没回填。
 */
function isBackfilled(articleText) {
  const line = articleText.split('\n').find((l) => /^\s*>\s*\*\*状态\*\*/.test(l))
  if (!line) return false
  return /https?:\/\//.test(line)
}

function backfillArticle(text, url) {
  let changed = false
  let out = text
  for (const re of PENDING_PATTERNS) {
    if (re.test(out)) {
      out = out.replace(re, `> **状态**：已发布 → ${url}（链接回填于脚本执行时）`)
      changed = true
      break
    }
  }
  return { text: out, changed }
}

/**
 * README 的「先读哪一篇？」表里已经引用了发布稿的仓库内路径。
 * 回填要做的是在同一行补上外链，让读者能直接跳到文章。
 */
function backfillReadme(text, url) {
  const lines = text.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.includes('docs/articles/2026-11-26') && !l.includes(url)) {
      lines[i] = `${l} · [已发布](${url})`
      changed = true
    }
  }
  return { text: lines.join('\n'), changed }
}

function appendChangelog(text, url) {
  if (text.includes(url)) return { text, changed: false }
  const marker = '\n'
  const entry = `${marker}## [未发布] 测量方法论长文对外发布\n\n- 掘金：${url}\n- 仓库内稿件：\`docs/articles/2026-11-26-我的基准测试说我的代码慢了20ms.md\`\n`
  // CHANGELOG 新条目放在第一个二级标题之前，保持倒序。
  const idx = text.indexOf('\n## ')
  const out = idx >= 0 ? text.slice(0, idx) + entry + text.slice(idx) : text + entry
  return { text: out, changed: true }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const articleText = read(ARTICLE)

  // --- --check 模式：给 CI / pre-push 用 ---
  if (args.check) {
    if (isBackfilled(articleText)) {
      console.log('✅ 长文链接已回填')
      process.exit(0)
    }
    console.error('❌ 长文仍是「待发布」，未回填外链。')
    console.error('   发布后运行: node scripts/backfill-article-links.mjs --url <文章URL>')
    process.exit(1)
  }

  assertUrl(args.url)

  if (isBackfilled(articleText)) {
    console.log('ℹ️ 长文已经回填过链接，跳过（幂等）。')
    console.log('   如需更换链接，请手动编辑', path.relative(REPO, ARTICLE))
    process.exit(0)
  }

  const a = backfillArticle(articleText, args.url)
  if (!a.changed) {
    fail(`在文章里找不到「状态：待发布」行，无法回填。\n   请手动编辑: ${path.relative(REPO, ARTICLE)}`)
  }

  const r = backfillReadme(read(README), args.url)
  const c = appendChangelog(read(CHANGELOG), args.url)

  if (args.dryRun) {
    console.log('--- dry-run，不会写文件 ---')
    console.log(`article : ${a.changed ? '会改' : '不变'}`)
    console.log(`readme  : ${r.changed ? '会改' : '不变'}`)
    console.log(`changelog: ${c.changed ? '会改' : '不变'}`)
    return
  }

  fs.writeFileSync(ARTICLE, a.text)
  fs.writeFileSync(README, r.text)
  fs.writeFileSync(CHANGELOG, c.text)

  console.log('✅ 回填完成')
  console.log(`   ${path.relative(REPO, ARTICLE)}  → 状态行已更新`)
  console.log(`   ${path.relative(REPO, README)}  → 已补外链`)
  console.log(`   ${path.relative(REPO, CHANGELOG)} → 已追加条目`)
  console.log('')
  console.log('下一步（别忘了）：')
  console.log('   git add -A && git commit -m "docs: 发布测量方法论长文（附链接）"')
  console.log('   然后在 #35 里更新「方法论长文」状态为已完成')
}

main()
