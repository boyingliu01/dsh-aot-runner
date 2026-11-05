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


def main():
    files = glob.glob("tests/**/coverage.cobertura.xml", recursive=True)
    if not files:
        print("no coverage.cobertura.xml found（先跑 dotnet test 收集覆盖率）")
        return 1

    per_class = collect(files[0])
    print_summary(per_class)
    print_per_class(per_class)
    return 0


if __name__ == "__main__":
    sys.exit(main())
