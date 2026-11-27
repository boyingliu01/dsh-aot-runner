# dsh-aot-runner

[![npm](https://img.shields.io/npm/v/@boyingliu01/dsh-aot-runner.svg)](https://www.npmjs.com/package/@boyingliu01/dsh-aot-runner)
[![license](https://img.shields.io/npm/l/@boyingliu01/dsh-aot-runner.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-win--x64-blue.svg)](#download)

> **NativeAOT replacement for the DSH subprocess runner.**
> Cuts **59–67%** of the per-subprocess runner overhead on Windows x64.
>
> 📖 [中文 README](README.md) · 📝 [Why my benchmark lied to me five times](docs/articles/publish/English.md)

DSH spawns a Node.js `runner.js` child process before every command. Loading the Node
runtime alone costs **200ms+** — more than the command you actually wanted to run.
This project replaces it with a native executable: **69–76ms**.

| | node runner | **AOT runner** |
|---|---|---|
| p50 | 156–158ms | **63–64ms** |
| p99 improvement | — | **73–124ms shorter tail** |
| jitter (IQR/median) | 11.7–20.5% | **1.9–4.1%** |

**Jitter matters as much as speed.** The node runner is inherently unstable; the AOT
runner holds 2–4%. In interactive use, predictable often beats fast.

---

## ⚠️ Read this before installing

**This is a Windows x64 plugin, and it currently requires a one-line upstream patch.**

DSH has a defect: `LocalSubprocessRuntime.spawn()` calls `launchWindowsJob()` /
`launchLinuxScope()` **without forwarding the `internals` argument**, so every
`internals`-based injection is silently ignored — including this plugin.

- The plugin **detects this automatically** and disables itself with a clear warning
  rather than pretending to work.
- Upstream discussion: [deepseek-ai/deepseek-harness#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)
  and [#12532](https://github.com/deepseek-ai/deepseek-harness/discussions/12532).
- A verified fix exists and applies cleanly to current `master`:
  [`vendor/upstream/aturzone-fix-d631ef32.patch`](vendor/upstream/aturzone-fix-d631ef32.patch).
- Patch tooling: `node vendor/patch-dsh.mjs status|apply|revert|verify`

> Upstream has **issues and PRs disabled** (`has_issues=false`), so Discussions is the
> only channel. If you hit this too, a comment in #12532 is more useful than a star here.

**Building from source requires a C++ toolchain.** NativeAOT on Windows mandates the
MSVC linker: .NET 8+ SDK **plus** the VS Build Tools C++ workload (~8GB).
Without it you get `error : Platform linker not found`.
**Prebuilt binaries are published — see below.**

---

## Download

| Method | For | You get |
|---|---|---|
| [**GitHub Releases**](https://github.com/boyingliu01/dsh-aot-runner/releases/latest) | Just want the exe | `dsh-aot-runner.exe` + `.zip` + `SHA256SUMS` |
| **npm** `@boyingliu01/dsh-aot-runner` | DSH integration (recommended) | plugin + bundled exe |
| **Build from source** | Modifying / auditing | Your own build (needs C++ toolchain) |

```powershell
Get-FileHash dsh-aot-runner.exe -Algorithm SHA256   # compare against SHA256SUMS
```

Release binaries are built by CI from the tagged commit — **no VC++ runtime dependency,
no .NET runtime dependency** (verified in CI).

---

## Why

Every DSH subprocess pays a fixed tax:

```
node.exe (dsh host) → node.exe runner.js -- <target> → target
```

The middle process re-loads the Node runtime, re-resolves its module tree, and runs an
IPC handshake every single time. Profiling shows it contributes a flat **200–220ms**.

### Measured on the real production path

Sampled through DSH's actual `launchWindowsJob` path — 3 rounds × 100 iterations,
alternating:

| Round | node p50 | AOT p50 | Gain | node jitter | AOT jitter | Failures |
|---|---|---|---|---|---|---|
| 1 | 156ms | 63ms | **59.3%** | 11.7% | 1.9% | 0 |
| 2 | 156ms | 64ms | **59.1%** | 11.8% | 2.8% | 0 |
| 3 | 158ms | 64ms | **59.6%** | 20.5% | 4.1% | 0 |

- **59.1–59.6%**, zero failures, zero output mismatches
- p99 tail improved by **73–124ms**
- Real commands (`hostname` / `whoami` / `cmd /c echo`) save **77–155ms** per call
- Stability: 0 failures over 120 consecutive calls, RSS 52.6 → 54.7MB (no growth)

> Absolute numbers swing with machine load; the **ratio** is the stable metric.
> Full methodology: [`docs/性能对比测试报告.md`](docs/性能对比测试报告.md) (Chinese).

---

## Design notes

### The call contract is matched exactly

The AOT build implements the **same Node IPC protocol** (fd 3), not a custom one:

```
[8-byte type (LE, usually 1)][8-byte payload length (LE)][JSON payload + '\n']
```

`stdio` layout: `[ignore, ignore, ignore, ipc, stdin, stdout, stderr, control]` →
`stdio[3]` = ipc, `stdio[4]` = target stdin, `stdio[5]` = stdout, `stdio[6]` = stderr,
`stdio[7]` = control.

The start request is strictly validated by `hasExactKeys` as `{type, cwd, env, control?}` —
**one extra field is rejected**. That is reproduced faithfully.

### Process creation (`CreateProcessW`)

| | Value |
|---|---|
| `lpApplicationName` | Absolute resolved path (bare names would use a sketchy search order) |
| `lpEnvironment` | Hand-built UTF-16LE block (`CREATE_UNICODE_ENVIRONMENT` needs double `\0`) |
| `dwCreationFlags` | `CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT` — suspend, join Job, resume |

Handles must come from `_get_osfhandle(4/5/6)`. `GetStdHandle(4)` returns
`INVALID_HANDLE_VALUE` because it queries the standard handle table (-10/-11/-12),
not the CRT fd table.

### Job Object

`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000)`,
`JobObjectExtendedLimitInformation`, struct is **144 bytes**.
When the runner exits, the whole process tree is reclaimed.

**This was measured, not assumed** — see
[`bench/isolation-value.js`](bench/isolation-value.js):

| Scenario | Inline (no runner) | Via runner | Isolation helps? |
|---|---|---|---|
| target crashes | host survives | host survives | ❌ no difference |
| target writes 200MB (host doesn't read) | stalls | stalls | ❌ no difference |
| target hangs | host responsive | host responsive | ❌ no difference |
| **target crashes + detached grandchildren** | **5 orphans survive** | **0 survive** | ✅ |

So the value of this process boundary is **not "crash protection" — it's
"process-leak protection."** Windows process isolation already covers crashes.
What needs the Job Object is orphans: children spawned `detached` outlive their parent
otherwise (measured: 5 survivors inline vs 0 with the runner).

### Executable resolution must match node, not be "smarter"

node's `resolveWindowsExecutable` rules, reproduced exactly:

1. Candidate extensions are **only `.com` and `.exe`**, and **`.com` wins** — no `.bat`/`.cmd`
2. With an explicit extension, check the literal name exactly once
3. Without a path separator: search cwd first (subject to `NODEFAULTCURRENTDIRECTORYINEXEPATH`), then PATH
4. No candidate found → **ENOENT**, rather than handing the bare name to `CreateProcessW`

> Rule 1 is counter-intuitive but mandatory: `npm` only ships `npm.cmd`. If the AOT build
> helpfully added `.cmd`, you'd get "node says ENOENT, AOT runs it" divergence.
> **Behavioral parity beats looking smarter.**

---

## Quick start

Prerequisites: .NET 8 SDK + MSVC linker (or use prebuilt binaries), Node.js 22+.

```bash
./build.sh              # incremental build
./build.sh --check      # quality gates only
./build.sh --test       # build + full regression (C# 346 + JS 100+)
./build.sh --all        # gates + clean rebuild + tests + benchmark
```

Install into DSH (plugin):

```bash
node vendor/patch-dsh.mjs status   # check the upstream patch
node vendor/patch-dsh.mjs apply    # apply if needed
```

Then in your profile's `package.json`:

```json
{ "dependencies": { "@boyingliu01/dsh-aot-runner": "^0.2.8" } }
```

and enable it in `cordis.patch.yml`:

```yaml
- id: aot-runner
  config:
    enabled: true
```

> Do **not** use `insert:` — the plugin already registers this entry; duplicating the
> `id` makes DSH silently ignore the config.

---

## ⭐ Read this first: measurement methodology

[`docs/测量方法论-当工具比被测对象更容易出错.md`](docs/测量方法论-当工具比被测对象更容易出错.md)

**The most valuable artifact in this repo is not the runner — it's what measuring it taught.**

The core claim: *a performance measurement's error usually comes from the measurement
method, not the thing being measured.* This project once measured "AOT is 20ms slower",
the exact opposite of its own baseline showing "68% faster" — because both candidates
were run on the wrong call path. The numbers looked plausible, so nobody questioned them.

**Five questions to ask of any performance number:**

1. Does my invocation match the real usage contract? (Read the source first.)
2. Are both groups under equal environmental load? (>5% load difference ⇒ invalid)
3. Is the difference larger than the measurement noise?
4. Am I inferring "current impact" from a "cumulative" figure?
5. If the conclusion were reversed, would the data still support it?

**Meta-rule:** when results are repeatedly "unreasonable", invert the order of suspicion —
**measurement tool first, environment second, code last.**

Reusable library (no project coupling, copy the whole file):

```js
import { aggregate, VERDICT } from './lib/bench-verdict.mjs';
const v = aggregate(rounds);   // MEASURED | GAIN_CONSISTENT | UNRELIABLE
```

Its stance: **return `UNRELIABLE` rather than a confidently wrong conclusion.**

English article: [`docs/articles/publish/English.md`](docs/articles/publish/English.md)

---

## Status

| Stage | Status |
|---|---|
| Protocol alignment (Node IPC fd 3) | ✅ byte-identical across 53 A/B cases |
| Production path integration | ✅ plugin + circuit breaker |
| Release pipeline | ✅ fail-closed (npm + GitHub Release, SHA256SUMS) |
| Contract drift detection | ✅ automated + pre-commit hook |
| Contract branch coverage | ✅ ratcheted gate (currently 27.7%) |

- **C# 346 tests + 100+ JS tests**, production source coverage 100% (878/878 lines)
- Circuit breaker: worst case affects only 3 calls, recovers on the 4th
- Design records: 1 ADR (`docs/adr/`) + 2 design/retro plans (`docs/plans/`)

**Known limitation:** upstream #11893 is unfixed as of 2026-11-27, so the plugin
requires the one-line patch to take effect. Without it, it self-disables with a warning.

---

## Reuse prerequisite

This runner reuses DSH internal contracts from `@deepseek-ai/dsh-subprocess-local`.
**On every DSH upgrade, re-verify:**

- `runner.js` start request field set
- `WINDOWS_SPAWN_ERROR_CODES` mapping
- `resolveWindowsExecutable` candidate extensions and search order
- `runnerStdio` fd layout

`test/ab-verify.js` catches drift — it is the regression gate, do not delete it.

---

## License

MIT © boyingliu01
