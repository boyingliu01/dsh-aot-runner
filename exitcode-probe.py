"""A/B 探针：设置任意 32 位退出码。

为什么需要这个探针而不是 sys.exit(N)：
    Python 的 sys.exit() 只接受 int32 范围内的值，超出时**自己报错退出**
    （实测 sys.exit(2147483648) → 进程退出 127，不是 2147483648）。
    那样测出来的差异是 Python 造成的假象，与 runner 无关。
    ExitProcess 直接调 Win32，能设置完整的 0..4294967295。
"""
import ctypes
import sys

ctypes.windll.kernel32.ExitProcess(ctypes.c_uint32(int(sys.argv[1])).value)
