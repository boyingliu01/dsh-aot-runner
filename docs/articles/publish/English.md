# My benchmark said my code was 20ms slower. The benchmark was wrong. It happened five times.

> Draft for Hacker News / r/programming / dev.to.
> **Status**: not yet published. Publish after the Chinese version if you want
> to stagger the two, or ship both the same week.

---

I built a native replacement for the Node.js subprocess launcher inside DSH
(an AI coding assistant's host). In theory it eliminates the cost of re-loading
the Node runtime every time a subprocess spawns.

I finished the first version and ran a benchmark. The result:
**my implementation was 20ms slower.**

I almost deleted the whole project.

The problem was that **the benchmark was wrong.**

This happened **five times** over the three-plus weeks I worked on this project.
All five were the same class of error: **the measuring tool was broken, but the
numbers looked plausible.**

A good-looking wrong number is more dangerous than no number at all — because
nobody questions it.

Here are the five, and the rules I took away. If you do performance work,
you've probably hit these too; you just might not have known it.

---

## Case 0: the "reverse result" that gave the wrong sign

I wanted a rough comparison, so I wrote a ten-line script:

```js
const t0 = performance.now();
spawn(runnerPath, ['--', ...argv], { stdio: 'ignore' });  // ← here
```

Result: the AOT build was 20ms slower.

The problem is `stdio: 'ignore'`. The real invocation contract requires
`stdio[3] = 'ipc'` — the runner has to handshake over that IPC channel, send and
receive control messages, and report the child's exit code. With `stdio: 'ignore'`,
both candidates ran from "protocol entry" straight to "fail and exit."

**Both were running on the wrong path — so that 20ms measured the difference
between two error paths, not between two implementations.**

Under the real contract, the AOT build was 68% faster.

> **Rule 1: read the invocation contract before you design the measurement.**
> Get the invocation wrong and your number has nothing to do with real
> performance — and it's wrong in a way that looks like real data.

I later wrote this into the first three lines of the benchmark script, so that
future me (and anyone else) hits the warning before "simplifying" the `stdio`.

---

## Case 1: a lighter baseline under-reports your own win

After fixing the contract, I used the real stdio layout. But the baseline was
still hand-written:

```js
// "just run the same thing under node" — looks equivalent
const baseline = () => spawn('node', ['-e', 'console.log(1)']);
```

Result: AOT saved 9%.

Switching to DSH's real `runner.js`: **68%.**

`node -e 'console.log(1)'` is far lighter than `runner.js`. It does no IPC
handshake, no module resolution, no control channel. **A light baseline can't
measure the benefit of replacing something heavy.**

> **Rule 2: use the system's own benchmark tool; don't invent a "simplified" baseline.**
> A hand-rolled baseline is always lighter — and the part it's missing is
> exactly the part you're optimizing.

---

## Case 2: using cumulative CPU seconds to diagnose "a serious bottleneck"

This one was my own machine sitting at 90% CPU all day.

I looked at cumulative CPU time with `Get-Process` and found an input-method
updater at **1451 seconds**. Looks enormous.

Different arithmetic: `1451s ÷ 86400s ≈ 0.017 cores = 0.20% of system compute`.
Real-time sampling confirmed: 0.20%.

**"1451 cumulative seconds" and "slowing you down right now" are different
questions.** One is a historical total; the other is current occupancy. I read
one as the other.

> **Rule 3: judge impact with real-time occupancy, not cumulative totals.**

---

## Case 3: monotonic sequences look like a treatment effect

The most common self-deception in benchmarking is A-B-A: baseline, then
optimization, then baseline again.

If you get `A1 = high`, `B = middle`, `A2 = low`, the instinct is to read it as
"B is better than A1." But **A2 being lower than B** tells you what's really
moving is *time*, not the treatment. Background jobs finishing, caches warming,
clock frequencies recovering — any of those causes monotonic drift.

This project hit a subtler version: in the load-matrix experiment, the order
inside each band was "run all 20 node iterations, then all 20 AOT iterations."
Within each band, *time* and *implementation* were **collinear** — whichever ran
second always got the advantage, and there was no way to separate the two from
the data.

So the rule here is now **ABBA alternation**: `A, B, B, A`, so the time trend
cancels symmetrically. Every performance number in the README is annotated with
its sampling scheme ("ABBA, one round each, four rounds × 25 iterations") so a
reader can judge whether the drift was cancelled.

Even so, **ABBA doesn't save you every time.** One ABBA experiment had the two
arms differing by 10 percentage points in load, with the effect pointing
*opposite* to the load difference. The correct conclusion was **"not comparable
this round"** — not "pick whichever arm looks better."

> **Rule 4: A-B-A isn't enough — alternate ABBA, and record the load per round.
> Discard any comparison where the arms differ by more than 5% in load.**

---

## Case 4: under high load, the noise swallows every conclusion

I wanted to check whether AOT was *more stable* under load. Three runs:

| Run | node dispersion | AOT dispersion | More stable? |
|---|---|---|---|
| 1 | 59.6% | 15.6% | AOT |
| 2 | 38.4% | 63.5% | **node** |
| 3 | 13.0% | 6.3% | AOT |

**The direction flipped once.**

Had I run it once — and the first one, at that — I would have confidently
announced that AOT has significantly lower dispersion under load. But one of
three runs pointing the other way means **the metric itself isn't repeatable
enough under load to support any conclusion.**

A regression later showed load explains nearly all the variance; everything
else I could think of ("optimization", "JIT warmup", "page cache") added up to
a small remainder. In other words, under load I was mostly measuring **how busy
the machine was at that instant.** (I'm deliberately not quoting the regression
coefficients: they don't transfer between machines, and quoting them invites
people to apply them to their own setup.)

> **Rule 5: wait for the load to drop before measuring, and always report the load.
> A comparison with more than 5% load difference is invalid.**

---

## Case 5: the gate "ran" and checked nothing

This one is the nastiest, because **it lies in the favorable direction.**

I added a check to the release pipeline: fail if no new version lands on npm.
But a direction flag was inverted — a permission that was always on made the
OIDC branch always true, so "Trusted Publisher not configured" fell through to
a "no NPM_TOKEN" branch, then `exit 0`.

Result: **green job, successful GitHub Release, nothing on npm, zero failure
signal.**

The check did run. It just didn't check anything.

Three more of the same family in the same period:

1. A gate said "contract file not found"; the real cause was **a missing
   environment variable**, with the exception swallowed. **The error message
   pointed in a direction unrelated to the actual cause.**
2. I concluded "this gate doesn't read that file" by **reasoning backward from a
   different implementation.** The real rule lived in that gate's own source,
   and it did read it. Deleting the file blocked the commit immediately.
3. I asserted "step A must come before step B." The assertion passed, CI was
   green — but the path A produced was invisible to B. **The order was right;
   the wiring was never connected.**

> **Rule 6: a structural assertion can't prove connectivity.**
> "Who comes before whom" is necessary, not sufficient. To prove "A finds B",
> make A actually go find B.

That rule turned into a concrete practice here: **every time I add a check,
I deliberately break the thing under test and confirm the check goes red.**
If it doesn't, the check was empty.

This is not theoretical — while writing this article I fixed a self-test that
had been **silently red for days**, and my own mutation testing caught it
**twice in a row**: the first version matched `--check` in a *comment*, and the
second was fooled by `args.includes('--check')` — the script *reading* the flag
rather than *passing* it.

---

## One meta-rule

If you remember only one thing:

> **When measurements keep coming out "unreasonable," invert the order of
> suspicion: suspect the measuring tool first, then the environment, and
> suspect the code under test last.**

Both of my expensive misjudgments had the identical cost structure:
`assume the code is wrong → read the code` → `assume the environment is wrong →
investigate the environment` → `discover the measurement assumption was wrong →
five-minute fix`.

The expensive parts are always "read the code" and "investigate the environment."

---

## What these rules cost

Honestly? "I can't measure that" is expensive:

- You can't write "AOT is more stable under load" in a status update, even
  though it sounds great.
- You have to admit you ran it three times and still have no conclusion.
- Your benchmark report contains the word `UNRELIABLE`, which looks unprofessional.

But I've seen worse: **a confidently wrong conclusion makes an entire team act
on a false premise.**

In this project, if I had accepted that first 20ms, I would have deleted an
implementation that is actually 68% faster — because "it doesn't help."

> **A wrong conclusion is worse than no conclusion.**

---

## Something you can use

I turned the judgment into a small library (no project coupling — copy the
whole file into any Node project):

```js
import { aggregate, VERDICT } from './lib/bench-verdict.mjs';

const v = aggregate(rounds);
// → MEASURED | GAIN_CONSISTENT | UNRELIABLE
```

Its position is this article's position: **return `UNRELIABLE` rather than
return a confidently wrong answer.**

- Full write-up (8 cases, 6 rules, anti-pattern list):
  [docs/测量方法论](https://github.com/boyingliu01/dsh-aot-runner/blob/main/docs/%E6%B5%8B%E9%87%8F%E6%96%B9%E6%B3%95%E8%AE%BA-%E5%BD%93%E5%B7%A5%E5%85%B7%E6%AF%94%E8%A2%AB%E6%B5%8B%E5%AF%B9%E8%B1%A1%E6%9B%B4%E5%AE%B9%E6%98%93%E5%87%BA%E9%94%99.md)
- Judgment library: [lib/bench-verdict.mjs](https://github.com/boyingliu01/dsh-aot-runner/blob/main/lib/bench-verdict.mjs)
- Measurement discipline (contributor guide): [CONTRIBUTING.md §4](https://github.com/boyingliu01/dsh-aot-runner/blob/main/CONTRIBUTING.md)
- Project: [dsh-aot-runner](https://github.com/boyingliu01/dsh-aot-runner)

---

## About that project (an honest status note)

If you came for the performance angle, here's where the project actually stands —
**it isn't really usable yet.**

The core works, the performance is verified, and the release pipeline is wired
up. But it depends on an upstream fix: DSH calls two `launch*` functions without
forwarding an `internals` argument, so every injection through that seam is
silently ignored.

I filed it in [discussion #11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)
24 days ago. Upstream has shipped three versions since (0.2.2-rc.5,
0.2.3-alpha.1, 0.2.3-alpha.2) without fixing it — and **the line in question is
still line 1574, identical across all three.**

The interesting part: when upstream refactored, they **kept the parameter and
kept the local variable — they just never forwarded it.** That means it wasn't
"forgot to add it"; it's that **the code path was never covered by a test.**
Which is exactly this article's theme showing up from a different angle.

There *is* an independent fix now — a third-party contributor reproduced the
bug and pushed a branch with tests — but it hasn't been merged, because the
repo has issues and PRs disabled.

So the project ships with a one-line patch (one file, one argument insertion,
fully reversible) and a complete verification story: see
[vendor/README.md](https://github.com/boyingliu01/dsh-aot-runner/blob/main/vendor/README.md).

**If you use DSH**, dropping a note in that discussion is worth far more than a
star on my repo.
