"""从 cobertura XML 汇总真实覆盖率（区分生产源码与被测程序集内的测试代码）。

用途：dotnet test + coverlet 产出的 coverage.cobertura.xml 里，
因为测试项目是直接 Compile 主项目源码（而非 ProjectReference），
测试代码与被测代码混在同一个程序集里。直接看文件顶部的 line-rate
会把「测试自己覆盖自己」算进分母，得到一个虚高的数字。

这个脚本把两者分开，并给出每个生产类的覆盖率，便于找出真正没被测到的部分。

@no-test-required: 这是给人看的报告脚本（读 XML 打印表格），不含业务逻辑，
其正确性由 build.sh --check 的实际输出直接验证（数字对不上会立刻看出来）。
单独为它写测试只会测「格式化字符串是否等于我写的字符串」，没有回归价值。
"""
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

BACKSLASH = chr(92)
SLASH = "/"

# 判定「测试代码/第三方」的路径特征：这些不算生产源码覆盖率
NON_SOURCE_MARKERS = ("tests/", ".nuget")


def norm(path):
    """统一路径分隔符，便于跨平台做包含判断。"""
    return (path or "").replace(BACKSLASH, SLASH)


def is_non_source(filename):
    """该文件是否属于测试代码或第三方包（不计入生产覆盖率）。"""
    return any(marker in filename for marker in NON_SOURCE_MARKERS)


def pct(hit, valid):
    """百分比；分母为 0 时返回 0.0 而不是抛异常。"""
    return 100.0 * hit / valid if valid else 0.0


def class_stats(element):
    """从 <class> 元素读出 (命中行数, 有效行数)。"""
    lines = element.findall("./lines/line")
    hit = sum(1 for line in lines if int(line.get("hits")) > 0)
    return hit, len(lines)


def collect(path):
    """解析 cobertura XML，返回 {类名: (是否非源码, 命中行, 有效行)}。"""
    root = ET.parse(path).getroot()
    per_class = {}
    for cls in root.iter("class"):
        name = cls.get("name") or "?"
        hit, valid = class_stats(cls)
        per_class[name] = (is_non_source(norm(cls.get("filename"))), hit, valid)
    return per_class


def totals(per_class, want_non_source):
    """按「是否非源码」筛选后求和。"""
    hit = valid = 0
    for non_source, cls_hit, cls_valid in per_class.values():
        if non_source == want_non_source:
            hit += cls_hit
            valid += cls_valid
    return hit, valid


def print_summary(per_class):
    """打印源码/测试/合计三行汇总。"""
    src_hit, src_valid = totals(per_class, want_non_source=False)
    tst_hit, tst_valid = totals(per_class, want_non_source=True)

    print("=== 覆盖率汇总（cobertura line-rate）===")
    print("生产源码:  %5.1f%%  (%d/%d 行)" % (pct(src_hit, src_valid), src_hit, src_valid))
    print("测试代码:  %5.1f%%  (%d/%d 行)" % (pct(tst_hit, tst_valid), tst_hit, tst_valid))
    combined = pct(src_hit + tst_hit, src_valid + tst_valid)
    print("合计:      %5.1f%%  (%d/%d 行)"
          % (combined, src_hit + tst_hit, src_valid + tst_valid))


def print_per_class(per_class):
    """按覆盖率从低到高打印生产类的明细（低的先看）。"""
    rows = [(valid, name, hit)
            for name, (non_source, hit, valid) in per_class.items()
            if not non_source]
    print()
    print("=== 生产源码逐类（低覆盖在前）===")
    for valid, name, hit in sorted(rows, key=lambda r: pct(r[2], r[0])):
        print("  %5.1f%%  %-40s %d/%d" % (pct(hit, valid), name, hit, valid))


# ---- 覆盖率门槛（ratchet）----
#
# 为什么要有门槛：覆盖率只会「一次性拉高、然后慢慢滑落」。
# 没有硬门槛时，新加的代码很容易悄悄把整体拉低，且没人会注意到。
#
# 门槛值取「当前实测值向下取整」，之后再逐步抬高（ratchet）。
# 加功能时覆盖率可能小幅下降，那就同时补测试 —— 这是有意的摩擦。
#
# 与被测代码同源维护：改了阈值必须在本文件里改，评审时一眼能看到。
THRESHOLDS = {
    "生产源码": 99.0,
}


def check_thresholds(per_class):
    """核对覆盖率门槛；未达标返回 False。"""
    src_hit, src_valid = totals(per_class, want_non_source=False)
    actual = pct(src_hit, src_valid)

    print()
    print("=== 覆盖率门槛 ===")
    ok = True
    for label, floor in THRESHOLDS.items():
        got = actual
        status = "PASS" if got >= floor else "FAIL"
        if got < floor:
            ok = False
        print("  %-8s 实际 %5.1f%%  门槛 %5.1f%%  %s" % (label, got, floor, status))
    return ok


def is_empty_report(path):
    """报告是否为空（根元素 lines-valid="0"）。

    只扫文件头部而不是完整解析 XML：这一步用于过滤候选，
    不需要结构信息，也不想为一份损坏的文件抛异常。
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            head = handle.read(4096)
    except OSError:
        return True
    match = re.search(r'lines-valid="(\d+)"', head)
    return match is not None and int(match.group(1)) == 0


def pick_latest_report():
    """挑出最新的一份**非空**覆盖率报告。

    这里踩过的坑（2026-11-06 修复）：原实现是 `per_class = collect(files[0])`，
    而 `glob.glob` 返回的是**文件系统顺序**，不是时间序。
    `tests/**/TestResults/` 下会累积历史报告（每次 `dotnet test` 生成一个新 GUID 目录），
    其中还有 `lines-valid="0"` 的空报告。实测 `files[0]` 恰好命中一份空报告，
    脚本输出 `0.0% (0/0 行)` —— 真实值是 41.3%。

    更糟的是这个错误**看起来像真的**：数字格式正确、表格也打出来了，只是全是 0。
    覆盖率门禁因此长期处于「有输出但无意义」的状态。

    选取规则：先丢弃空报告，再按 mtime 取最新。

    @returns {(str|None, str|None)} (路径, 错误信息)，二者恰有一个为 None
    """
    files = glob.glob("tests/**/coverage.cobertura.xml", recursive=True)
    if not files:
        return None, "no coverage.cobertura.xml found（先跑 dotnet test 收集覆盖率）"

    nonempty = [f for f in files if not is_empty_report(f)]
    if not nonempty:
        return None, (
            "找到 %d 份报告，但全部是 lines-valid=0 的空报告。\n"
            "这通常意味着 coverlet 数据收集器没有正确注入 ——\n"
            "检查 tests/DshAotRunner.Tests/coverage.runsettings 是否生效。" % len(files)
        )

    return max(nonempty, key=os.path.getmtime), None


def main():
    path, error = pick_latest_report()
    if path is None:
        print(error)
        return 1

    per_class = collect(path)
    print("报告: %s" % norm(path))
    print_summary(per_class)
    print_per_class(per_class)
    return 0 if check_thresholds(per_class) else 1


if __name__ == "__main__":
    sys.exit(main())
