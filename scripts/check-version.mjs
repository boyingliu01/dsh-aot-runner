#!/usr/bin/env node
/**
 * 版本一致性检查（对应 xp-gate Gate 0）
 *
 * 检查三处版本号是否一致：
 *   VERSION          —— 项目版本的事实来源
 *   package.json     —— 仓库根（private，只管本地脚本）
 *   plugin/package.json —— 要发布到 npm 的插件包
 *
 * 为什么需要它：0.1.0 发布时 VERSION 还停在 1.0.0，两者相差一个大版本。
 * 版本号分裂不会让任何东西跑不起来，所以没人会注意到 —— 直到有人问
 * "到底哪个是当前版本"。Gate 0 存在的意义就是拦住这种沉默的漂移。
 *
 * 用法：
 *   node scripts/check-version.mjs          # 检查
 *   node scripts/check-version.mjs --tag    # 额外校验 git tag 是否匹配
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 读 JSON 文件，失败时给出可操作报错而不是堆栈。 */
function readJson(relPath) {
  const full = resolve(ROOT, relPath);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 ${relPath}: ${error.message}`);
  }
}

/** 读纯文本版本号（去空白）。 */
function readVersionFile(relPath) {
  try {
    return readFileSync(resolve(ROOT, relPath), 'utf8').trim();
  } catch {
    return null;
  }
}

/** 取最近的 git tag 并去掉前缀 v。 */
function latestTag() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

/** 收集所有需要比对版本的来源。 */
function collectSources(checkTag) {
  const sources = [
    { label: 'VERSION', value: readVersionFile('VERSION') },
    { label: 'package.json', value: readJson('package.json').version },
    { label: 'plugin/package.json', value: readJson('plugin/package.json').version },
  ];

  if (checkTag) {
    sources.push({ label: 'git tag（最近）', value: latestTag() });
  }
  return sources;
}

/** 打印每个来源的当前值。 */
function printSources(sources) {
  console.log('版本一致性检查');
  console.log('─'.repeat(50));
  for (const { label, value } of sources) {
    console.log(`  ${label.padEnd(20)} ${value ?? '(缺失)'}`);
  }
  console.log('');
}

/** 检查是否有来源缺失版本号；全部齐全返回 true。 */
function checkMissing(sources) {
  const missing = sources.filter((s) => !s.value);
  if (missing.length === 0) return true;

  console.error(`❌ 以下来源缺失版本号：${missing.map((s) => s.label).join('、')}`);
  return false;
}

/** 检查所有来源是否一致；一致返回 true。 */
function checkMismatch(sources) {
  const unique = new Set(sources.map((s) => s.value));
  if (unique.size === 1) return true;

  console.error('❌ 版本号不一致，请统一为同一版本：');
  for (const { label, value } of sources) {
    console.error(`     ${label} = ${value}`);
  }
  console.error('\n修正方式：把四处都改成同一个版本号（通常以 VERSION 为准）。');
  return false;
}

function main() {
  const sources = collectSources(process.argv.includes('--tag'));
  printSources(sources);

  if (!checkMissing(sources)) return 1;
  if (!checkMismatch(sources)) return 1;

  console.log(`✅ 全部一致：${sources[0].value}`);
  return 0;
}

process.exit(main());
