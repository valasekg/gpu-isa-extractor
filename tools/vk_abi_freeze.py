#!/usr/bin/env python3
"""Freeze the Vulkan struct ABI, as a C compiler computes it, for the test suite to check.

`src/vk_compile.py` describes several dozen Vulkan structs in ctypes. If any one of them has
a field at the wrong offset, the driver reads a plausible value from the wrong place and the
result is a shader that compiles to the wrong thing rather than an error - so the layouts have
to be checked against an authority, and the authority is the real headers.

This is the *maintainer's* tool, not the test. It generates a C program FROM the ctypes
declarations (so the two cannot drift apart by editing one), compiles it against the real
Vulkan headers, runs it, and writes `tools/vk_abi.json`. `tools/test_gfx.js` then compares
that frozen file against what ctypes computes - which needs no compiler and no Vulkan SDK, so
it runs anywhere the rest of the suite does.

Re-run it when a struct is added or a field changes:

    py tools/vk_abi_freeze.py            # needs the Vulkan SDK and a C compiler
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

import vk_compile                                            # noqa: E402

OUT = os.path.join(ROOT, "tools", "vk_abi.json")


def generate_c(report):
    """A C program that prints the same JSON shape `vk_compile.layout_report()` produces.

    Generated from the ctypes declarations rather than written out, so a struct added on one
    side cannot be silently missing from the other.
    """
    lines = ["#include <vulkan/vulkan.h>", "#include <stdio.h>", "#include <stddef.h>", "",
             "int main(void)", "{", '    printf("{\\n");']
    names = sorted(report)
    for i, struct in enumerate(names):
        lines.append('    printf("  \\"%s\\": {\\"sizeof\\": %%zu, \\"fields\\": {", '
                     'sizeof(%s));' % (struct, struct))
        fields = sorted(report[struct]["fields"])
        for k, field in enumerate(fields):
            separator = "" if k == len(fields) - 1 else ", "
            lines.append('    printf("\\"%s\\": %%zu%s", offsetof(%s, %s));'
                         % (field, separator, struct, field))
        lines.append('    printf("}}%s\\n");' % ("" if i == len(names) - 1 else ","))
    lines += ['    printf("}\\n");', "    return 0;", "}", ""]
    return "\n".join(lines)


def main():
    report = vk_compile.layout_report()
    source = generate_c(report)

    scratch = os.path.join(ROOT, "tools", "_vk_abi")
    os.makedirs(scratch, exist_ok=True)
    c_path = os.path.join(scratch, "abi.c")
    with open(c_path, "w", encoding="utf-8") as h:
        h.write(source)

    sdk = os.environ.get("VULKAN_SDK")
    if not sdk:
        sys.stderr.write("VULKAN_SDK is not set; the real headers are needed to freeze the ABI\n")
        return 2

    exe = os.path.join(scratch, "abi.exe")
    if sys.platform == "win32":
        vcvars = os.environ.get("VCVARS64", r"C:\Program Files\Microsoft Visual Studio\2022"
                                             r"\Community\VC\Auxiliary\Build\vcvars64.bat")
        if not os.path.exists(vcvars):
            sys.stderr.write("set VCVARS64 to your vcvars64.bat (looked at %s)\n" % vcvars)
            return 2
        # Run from the scratch directory with bare names. A quoted path ending in a backslash
        # (`/Fo:"...\"`) has its closing quote escaped by that backslash, which cl then reads
        # as one mangled argument - so the paths are kept out of the command line entirely.
        # shell=True, not ["cmd.exe", "/c", cmd]. Passing it as a list makes Python quote the
        # whole command as one argument and backslash-escape the quotes inside it, which cmd
        # then reads as a mangled path - it fails before the compiler is ever reached.
        cmd = ('"%s" >nul 2>&1 && cl /nologo /I"%s\\Include" abi.c /Fe:abi.exe'
               % (vcvars, sdk))
        built = subprocess.run(cmd, cwd=scratch, shell=True, capture_output=True, text=True)
    else:
        exe = os.path.join(scratch, "abi")
        built = subprocess.run(["cc", "-I%s/include" % sdk, "abi.c", "-o", "abi"], cwd=scratch,
                               capture_output=True, text=True)
        exe = os.path.join(scratch, "abi")
    if built.returncode != 0:
        # Print what the compiler said. "did not compile (exit 1)" on its own sends whoever
        # runs this hunting through a generated C file for a fault that is usually one line.
        sys.stderr.write("the ABI probe did not compile (exit %d)\n%s%s\n"
                         % (built.returncode, built.stdout or "", built.stderr or ""))
        return 2

    out = subprocess.run([exe], capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write("the ABI probe did not run (exit %d)\n" % out.returncode)
        return 2

    data = json.loads(out.stdout)
    with open(OUT, "w", encoding="utf-8") as h:
        json.dump(data, h, indent=1, sort_keys=True)
        h.write("\n")
    print("froze %d struct(s) to %s" % (len(data), os.path.relpath(OUT, ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
