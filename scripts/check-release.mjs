#!/usr/bin/env node
/**
 * 发布前置检查（issue #23）：确认要打包出去的产物就是刚构建的那一份。
 *
 * 检查两件事：
 *   1. plugin/bin/*.exe 与 dist/*.exe **字节一致**
 *   2. plugin/bin/ 里没有会被打包但来路不明的残留（*.old 等）
 *
 * ## 为什么需要它
 *
 * `plugin/package.json` 的 `files` 含 `"bin/"`，所以发布出去的 npm 包带的是
 * `plugin/bin/*.exe`。而这个文件是 `build.sh` 从 `dist/` 复制过去的 ——
 * 复制这一步**可能失败**：DSH 会话本身就在通过它跑子进程，
 * 于是 `cp` 报 "Device or resource busy"。
 *
 * `build.sh:344+` 已经会 `exit 3` 并告警，防护是对的。问题在于**告警会被忽略** ——
 * 2026-11-07 就发生过一次：那次构建退出码非 0，但没人处理，
 * 之后发布出去的包里躺着 11-07 的旧 exe，而源码已经是 11-09 的。
 *
 * 构建期的告警挡不住发布，发布前的检查才能。所以这里再挡一道。
 *
 * ## 为什么单独一个脚本而不是塞进 check-version.mjs
 *
 * 版本一致性（Gate 0）会在**每次** pre-commit 跑，而且是纯文本比对，
 * 几乎无成本。产物一致性要读两个 1.3MB 的二进制并逐字节比，
 * 而且只在**发布前**才有意义 —— 塞进每次提交的路径会让门禁变慢却挡不住东西。
 *
 * 用法：
 *   node scripts/check-release.mjs          # 检查，失败退出 1
 *   node scripts/check-release.mjs --json   # 机器可读输出
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE_NAME = 'dsh-aot-runner.exe';

const DIST_EXE = resolve(ROOT, 'dist', EXE_NAME);
const PLUGIN_BIN = resolve(ROOT, 'plugin', 'bin');
const PLUGIN_EXE = resolve(PLUGIN_BIN, EXE_NAME);

/** 结果累积。每条都带上「怎么修」，而不是只说哪里错了。 */
const problems = [];

/** 记录一个问题。`fix` 是给人看的下一条命令或操作。 */
const fail = (title, detail, fix) => problems.push({ title, detail, fix });

/**
 * 检查两个文件是否字节一致。
 *
 * 先比长度再逐字节比：长度不同能立刻给出结论（且信息量更大 ——
 * 「差 9216 字节」比「第 265 字节起不同」更能说明是两代构建产物），
 * 长度相同时才需要读内容。
 */
function diffReport(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) {
    return { same: false, why: `大小不同：dist ${sa.size} 字节 vs plugin/bin ${sb.size} 字节（差 ${sa.size - sb.size}）` };
  }
  const ba = readFileSync(a);
  const bb = readFileSync(b);
  if (Buffer.compare(ba, bb) === 0) return { same: true, why: null };

  // 大小相同但内容不同：找到第一个不同的字节位置，便于排查
  let at = 0;
  while (at < ba.length && ba[at] === bb[at]) at++;
  return { same: false, why: `大小相同但内容不同，首个差异在偏移 ${at}` };
}

/** 主检查：dist 与 plugin/bin 的 exe 必须一致。 */
function checkExeSync() {
  if (!existsSync(DIST_EXE)) {
    fail(
      'dist/ 下没有构建产物',
      `找不到 ${EXE_NAME}。发布包里要带的 exe 来自 dist/，没有它就无法确认一致性。`,
      '先跑 ./build.sh 构建，再重新执行本检查。',
    );
    return;
  }
  if (!existsSync(PLUGIN_EXE)) {
    fail(
      'plugin/bin/ 下没有 exe',
      `plugin/package.json 的 files 含 "bin/"，所以发布包里本应带 ${EXE_NAME}，但它不存在。`,
      '跑 ./build.sh —— 它会把 dist/ 的产物同步到 plugin/bin/。',
    );
    return;
  }

  const { same, why } = diffReport(DIST_EXE, PLUGIN_EXE);
  if (!same) {
    fail(
      'plugin/bin 的 exe 与 dist 不一致',
      `${why}。发布出去的 npm 包会带上 plugin/bin 里的旧 exe，` +
        `与刚构建的源码不是一回事。`,
      // 这条建议必须点明「为什么上次会不同步」，否则用户会直接 cp 掩盖问题
      '关闭正在使用该 exe 的 DSH 会话后重跑 ./build.sh。' +
        '直接 cp 也能过这道检查，但先确认没有进程占用 —— 否则下次构建会再撞一次。',
    );
  }
}

/** 检查 plugin/bin 里有没有会被打包进去的残留。 */
function checkStrayArtifacts() {
  if (!existsSync(PLUGIN_BIN)) return;
  const strays = readdirSync(PLUGIN_BIN).filter((n) => n !== EXE_NAME);
  if (strays.length === 0) return;

  fail(
    'plugin/bin/ 里有多余文件',
    `除 ${EXE_NAME} 外还有：${strays.join('、')}。` +
      '（files 里有 !bin/*.old 兜着，但那只覆盖 .old 后缀，其它名字会被打进包里。）',
    `确认这些文件不该发布后删掉：${strays.map((s) => join('plugin/bin', s)).join(' ')}`,
  );
}

function main() {
  checkExeSync();
  checkStrayArtifacts();

  const asJson = process.argv.includes('--json');
  if (asJson) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
    return problems.length === 0 ? 0 : 1;
  }

  console.log('发布前置检查');
  console.log('─'.repeat(50));
  if (problems.length === 0) {
    console.log(`✅ 产物一致：plugin/bin 与 dist 的 ${EXE_NAME} 逐字节相同`);
    return 0;
  }

  console.error(`❌ 发现 ${problems.length} 个问题：\n`);
  for (const { title, detail, fix } of problems) {
    console.error(`  · ${title}`);
    console.error(`    ${detail}`);
    console.error(`    修法：${fix}\n`);
  }
  console.error('这些检查是发布前的最后一道：它们过了，不代表质量好，');
  console.error('但没过就一定不能发 —— 发出去的包会和源码对不上。');
  return 1;
}

process.exit(main());
