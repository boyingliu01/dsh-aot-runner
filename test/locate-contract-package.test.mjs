import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findLibFiles } from 'file:///D:/projects/dsh-aot-runner/scripts/lib/locate-contract-package.mjs';

test('仓库内子目录里装的包也能找到（release.yml 的 baseline/ 布局）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-'));
  const lib = path.join(root, 'baseline', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'runner-launch-TEST.js'), 'function a(){}');

  // 关键：模拟 CI 上没有本机 DSH workspace 的环境。
  // 环境变量是全局的，测试里临时删掉再恢复。
  const saved = { DSH_HOME: process.env.DSH_HOME, USERPROFILE: process.env.USERPROFILE };
  delete process.env.DSH_HOME;
  delete process.env.USERPROFILE;
  try {
    const hit = findLibFiles(root, /runner-launch-.*\.js$/);
    assert.ok(hit, '在 baseline/ 下装的包必须能被找到 —— 否则发布 job 的覆盖率门禁必然 exit 3');
    assert.equal(path.resolve(hit.lib), path.resolve(lib));
    assert.deepEqual(hit.files, ['runner-launch-TEST.js']);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
