#!/usr/bin/env node
// 强转审计工具的**自测**。
//
// 为什么一个检查工具需要自己的测试：规则本身就是判断逻辑，改错了会有两种坏结果，
// 而且两种都不会有人立刻发现 ——
//   1. 漏报：真正的风险不报了，门禁全绿，比没有门禁更危险；
//   2. 误报：安全代码被报，开发者开始无脑加豁免，规则名存实亡。
//
// 所以这里锁住「该报的必须报」和「不该报的必须不报」两侧，
// 每条用例都对应一个真实场景或一个曾经踩过的坑。
//
// 用法：node test/cast-audit-selftest.mjs
// 退出码：0 = 全部符合预期；1 = 有偏差。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TOOL = path.join(REPO_ROOT, 'tools', 'cast-audit');

/** 每个用例：一段 C# 源码 + 期望被报出的行号集合。 */
const CASES = [
  {
    name: '无符号→有符号且装不下（真实出过的退出码 bug）',
    code: `
class T {
    static int Bad(uint u) => (int)u;
}`,
    expectLines: [3],
    why: 'uint.MaxValue 转 int 得到 -1，host 判协议非法',
  },
  {
    name: 'checked() 相当于 static_cast，不报',
    code: `
class T {
    static int Ok(uint u) => checked((int)u);
}`,
    expectLines: [],
    why: '溢出立即抛 OverflowException，正是我们想要的行为',
  },
  {
    name: '位掩码已保证值域，不报',
    code: `
class T {
    static byte Ok(int i) => (byte)(i & 0xFF);
}`,
    expectLines: [],
    why: '类型系统看不到值域约束，但掩码已经把高位清掉了',
  },
  {
    name: '窄化截断（无掩码）要报',
    code: `
class T {
    static byte Bad(int i) => (byte)i;
}`,
    expectLines: [3],
    why: '300 会静默变成 44',
  },
  {
    name: '有符号→无符号，负数会回绕，要报',
    code: `
class T {
    static uint Bad(int i) => (uint)i;
}`,
    expectLines: [3],
    why: '-1 会变成 4294967295',
  },
  {
    name: '常量转换编译器自己会管，不报',
    code: `
class T {
    static byte Ok(char c) => (byte)'=';
}`,
    expectLines: [],
    why: '常量在编译期算好，溢出会报 CS0221',
  },
  {
    name: '放宽方向的转换不报',
    code: `
class T {
    static int Ok(byte b) => (int)b;
    static long Ok2(int i) => (long)i;
}`,
    expectLines: [],
    why: '目标类型范围完全覆盖源，不会丢数据',
  },
  {
    name: '带理由的豁免生效',
    code: `
class T {
    // cast-audit:ignore 上游已保证不超过 int.MaxValue
    static int Ok(uint u) => (int)u;
}`,
    expectLines: [],
    why: '豁免必须写明理由，理由即知识固化',
  },
  {
    name: '不带理由的豁免无效',
    code: `
class T {
    // cast-audit:ignore
    static int Bad(uint u) => (int)u;
}`,
    expectLines: [4],
    why: '只写 ignore 等于让工具闭嘴，必须拒绝',
  },
  {
    name: '类型声明里的括号不是强转',
    code: `
class T {
    static void M(byte[] buffer, int count) { }
}`,
    expectLines: [],
    why: '正则方案会在这里误报，Roslyn 不会',
  },
  {
    name: '冗余的同类型强转不报',
    code: `
class T {
    static int Ok(int i) => (int)i;
}`,
    expectLines: [],
    why: '源与目标同类型，没有范围问题',
  },
];

function runTool(dir) {
  const r = spawnSync('dotnet', ['run', '--project', TOOL, '-c', 'Release', '--', dir], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    shell: false,
  });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

let pass = 0;
const failures = [];
const workDir = mkdtempSync(path.join(tmpdir(), 'cast-audit-selftest-'));

try {
  for (const [idx, c] of CASES.entries()) {
    // 每个用例单独一个目录，避免互相干扰。
    const caseDir = path.join(workDir, `case${idx}`);
    spawnSync('mkdir', ['-p', caseDir], { shell: false });
    writeFileSync(path.join(caseDir, 'T.cs'), c.code, 'utf8');

    const out = runTool(caseDir);
    const actual = [...out.matchAll(/T\.cs:(\d+):\d+\s+\[CASTR\d+\]/g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);

    const expected = [...c.expectLines].sort((a, b) => a - b);
    const ok = expected.length === actual.length && expected.every((v, i) => v === actual[i]);

    if (ok) {
      pass++;
      console.log(`  ✅ ${c.name}`);
    } else {
      failures.push({ name: c.name, why: c.why, expected, actual });
      console.log(`  ❌ ${c.name}`);
      console.log(`     期望行 [${expected.join(',')}]，实际 [${actual.join(',')}]`);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} 条不符合预期：`);
  for (const f of failures) {
    console.log(`   - ${f.name}（${f.why}）`);
  }
  process.exit(1);
}

console.log(`✅ 全部 ${pass}/${CASES.length} 条符合预期。`);
