---
name: Bug 报告（其他问题）
about: 崩溃、输出不一致、进程泄漏、测试失败等，不属于「插件不生效」的问题
title: 'bug: '
labels: ['bug']
---

> **如果是「装了插件但没生效」，请改用 [「插件不生效」](?template=plugin-not-working.yml) 模板** ——
> 那份表单会问几个关键诊断问题，能省一轮来回。
>
> **如果是安全问题，请不要开公开 issue**，走 [SECURITY.md](../../SECURITY.md)。

## 环境

| 项 | 值 |
|---|---|
| DSH 版本 | |
| `node --version` | |
| `dotnet --version` | |
| Windows 版本 | |
| 插件版本 / commit | |
| `node vendor/patch-dsh.mjs status` | |

## 现象

**期望**：

**实际**：

**复现步骤**（能稳定复现吗？大概多少次复现一次？）：

```
1.
2.
3.
```

## 证据

**报错原文**：

```
（贴原文，不要只描述「报错了」）
```

**相关日志 / 输出**：

## 分类（勾选适用的）

- [ ] 崩溃 / 异常退出（有没有 exit code？）
- [ ] 输出不一致（stdout / stderr / exitCode 与 node runner 不同）
- [ ] 进程泄漏（子进程结束后还有残留）
- [ ] 测试失败（哪一条？`npm test` 还是 `./build.sh --check`？）
- [ ] 构建失败（贴完整报错）
- [ ] 其他

## 我确认过

- [ ] 我看过 [docs/TODO.md](../../docs/TODO.md) 的「已知问题」—— 有些告警是**上游工具缺陷**的产物，改代码没用
- [ ] 我搜过现有 issue
- [ ] 这不是受管企业环境导致的签名/EDR 拦截（见 [SECURITY.md](../../SECURITY.md) §二）
