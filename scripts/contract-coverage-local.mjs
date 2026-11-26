#!/usr/bin/env node
/**
 * `contract:coverage` 的本地包装器 —— 把四态退出码翻译成「该不该让整条链变红」。
 *
 * ## 为什么需要这一层
 *
 * `scripts/contract-branch-coverage.mjs --check` 有四个退出码，它们的含义不同，
 * 而「不同」这件事必须由**调用方**来体现：
 *
 *   0  未回退                    → 通过
 *   1  回退                      → 失败（该补用例了）
 *   3  未测得（拿不到契约包）     → 警告（本机/CI 环境缺包是已知情况）
 *   4  基线缺失或过期            → **分两种**，见下
 *
 * ## exit 4 为什么必须再拆
 *
 * 基线过期有两个原因，补救方向相反：
 *
 *   a) **契约变了**（contractSha256 不匹配）→ 基线真过期，必须 `--update` 重标定。
 *      此时判失败是对的：否则「DSH 升级导致覆盖率下降」会被静默放过。
 *
 *   b) **Node 主版本变了** → 只是本机环境与基线口径不同。契约没变、代码没变，
 *      覆盖率数字只是不可比而已。判失败等于「在非 CI 的 Node 上跑就永远红」，
 *      而那种门禁最后一定会被忽略 —— 这比没有门禁更糟。
 *
 * 实测依据：v0.2.8 基线在 Node 22 上标定（CI 用 22），而开发机是 Node 26。
 * 同一份契约文件在两版上采到的函数**总数**都不同（114 vs 95），是 V8 切块方式
 * 变了，不是用例丢了。此时正确的结论是「本机跳过」，不是「覆盖率回退」。
 *
 * ## 判据不在这里重写
 *
 * 「是 a 还是 b」由 `--check` 自己的输出判断（它已经按原因分流了措辞）。
 * 这里只做翻译，不重新推导 —— 判据只应有一处，两处必然漂移。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const REPO = path.resolve(import.meta.dirname, '..');

const r = spawnSync(
  process.execPath,
  [path.join(REPO, 'scripts', 'contract-branch-coverage.mjs'), '--check'],
  { cwd: REPO, encoding: 'utf8' },
);

const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
process.stdout.write(out);

switch (r.status) {
  case 0:
    process.exit(0);
    break;
  case 1:
    console.error('\n❌ 契约分支覆盖率回退 —— 有分支不再被走到，该补用例了。');
    process.exit(1);
    break;
  case 3:
    console.warn('\n⚠️  契约分支覆盖率未测得（拿不到 DSH 契约包）。这不是「覆盖率为 0」。');
    process.exit(0);
    break;
  case 4:
    if (out.includes('Node 主版本变了')) {
      console.warn('\n⚠️  基线是用另一个 Node 主版本标定的 —— 本机跳过判定（不是失败）。');
      console.warn('   契约与代码都没变，只是本机 Node 与标定口径不同（本项目 CI 用 Node 22）。');
      console.warn('   要真正复核，请用与基线相同的 Node 重跑。');
      process.exit(0);
    }
    console.error('\n❌ 契约覆盖率基线缺失或过期（契约变了或基线文件丢失）。');
    console.error('   修正：node scripts/contract-branch-coverage.mjs --update');
    process.exit(1);
    break;
  default:
    console.error(`\n❌ 契约覆盖率检查异常退出（rc=${r.status}）—— 当作失败，不要当成通过。`);
    process.exit(1);
}
