"""列出每个生产类未覆盖的行号（按最新 cobertura 报告）。"""
import glob
import os
import xml.etree.ElementTree as ET

BACKSLASH = chr(92)

files = sorted(glob.glob("tests/**/coverage.cobertura.xml", recursive=True),
               key=os.path.getmtime)
root = ET.parse(files[-1]).getroot()

for cls in root.iter("class"):
    fn = (cls.get("filename") or "").replace(BACKSLASH, "/")
    if "tests/" in fn:
        continue
    lines = cls.findall("./lines/line")
    un = sorted(int(l.get("number")) for l in lines if int(l.get("hits")) == 0)
    if not un:
        continue
    ranges = []
    for n in un:
        if ranges and n == ranges[-1][1] + 1:
            ranges[-1][1] = n
        else:
            ranges.append([n, n])
    hit = len(lines) - len(un)
    print("\n### %s  %d/%d  uncovered=%d" % (cls.get("name"), hit, len(lines), len(un)))
    print("   " + " ".join(
        ("%d-%d" % (a, b)) if a != b else str(a) for a, b in ranges))
