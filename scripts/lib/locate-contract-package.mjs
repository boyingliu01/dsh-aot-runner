/**
 * 定位 DSH 的 `@deepseek-ai/dsh-subprocess-local` 包。供两个契约脚本共用。
 *
 * ## 为什么单独成一个文件
 *
 * `contract-branch-coverage.mjs` 与 `contract-fingerprint.mjs` 是「契约漂移检测」
 * 的两半 —— 前者算运行时覆盖率，后者算静态指纹。两者都需要先找到那个包，
 * 各自的查找逻辑完全一样（同一组候选目录、同一个优先级），于是形成了
 * 一段 54 token 的克隆（archlint / jscpd 都会报）。
 *
 * 这与 `bench/node-tuning/` 里的克隆性质**不同**：那些实验脚本刻意各自自包含，
 * 抽公共库会掩盖「每个实验独立」这个事实；而这里两个脚本本来就是同一件事的两半，
 * 查找逻辑必须**保持一致**，各自维护反而是 bug 的温床（改了一边忘了另一边，
 * 就会出现「指纹能算、覆盖率算不了」这种诡异现象）。
 *
 * ## 查找顺序
 *
 * 与 `test/runner-client.js` 的查找顺序保持一致。这里只负责「找到」，
 * 不校验 runner 是否可用 —— 契约脚本只读源码。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 包名（唯一出现处，避免两个脚本写死不同字符串）。 */
export const PACKAGE_NAME = '@deepseek-ai/dsh-subprocess-local';

/**
 * 列出可能的「node workspace 根」候选目录，按优先级排序。
 *
 * @param {string} repoRoot 本仓库根（作为最后的兜底）
 * @returns {string[]}
 */
export function candidateWorkspaceRoots(repoRoot) {
  const roots = [];

  // DSH_HOME 通常是 `.dsh` 目录，而 workspace 在它的**同级** users 目录下。
  if (process.env.DSH_HOME) {
    roots.push(
      path.join(process.env.DSH_HOME, '..', '.workbuddy', 'binaries', 'node', 'workspace'),
    );
  }

  if (process.env.USERPROFILE) {
    roots.push(
      path.join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'workspace'),
    );
  }

  roots.push(repoRoot);
  return roots;
}

/**
 * 列出包目录候选（各 workspace 根下的 node_modules 路径）。
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function candidatePackageDirs(repoRoot) {
  return candidateWorkspaceRoots(repoRoot).map((root) =>
    path.join(root, 'node_modules', ...PACKAGE_NAME.split('/')),
  );
}

/**
 * 找到包目录。找不到返回 null（调用方决定是报错还是降级）。
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function resolvePackageDir(repoRoot) {
  for (const dir of candidatePackageDirs(repoRoot)) {
    if (fs.existsSync(path.join(dir, 'lib'))) return dir;
  }
  return null;
}

/**
 * 找到包的 `lib` 目录，并返回其中匹配 `fileRe` 的文件名。
 *
 * @param {string} repoRoot
 * @param {RegExp} fileRe 文件名的匹配规则
 * @returns {{ lib: string, files: string[] } | null}
 */
export function findLibFiles(repoRoot, fileRe) {
  for (const pkgDir of candidatePackageDirs(repoRoot)) {
    const lib = path.join(pkgDir, 'lib');
    try {
      const files = fs.readdirSync(lib).filter((f) => fileRe.test(f));
      if (files.length > 0) return { lib, files };
    } catch {
      // 该目录不存在或无权限 —— 继续看下一个候选。
    }
  }
  return null;
}
