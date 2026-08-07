#!/usr/bin/env python3
"""Compile CUDA C++ to PTX with NVRTC.

NVRTC is the only CUDA front end that needs no host C++ compiler, which is what makes this
feature work on a machine with no MSVC - `nvcc` fails at "Cannot find compiler 'cl.exe' in
PATH" before it does anything else, in every mode, including -ptx and -E.

It ships as a DLL with no command-line front end, and the extension host (Node, no npm, no
native modules) has no way to call one. Python's ctypes is in the standard library, so this
file is the whole binding: about eighty lines, no dependencies, no build step.

Usage:  py nvrtc_compile.py <request.json>

    {"source": "k.cu", "output": "k.ptx", "options": ["--gpu-architecture=compute_86"],
     "nvrtc": "C:/.../nvrtc64_130_0.dll"}      # optional; searched for when absent

Exit codes: 0 compiled, 1 compile error (log on stderr), 2 nvrtc could not be loaded.
"""

import ctypes
import glob
import json
import os
import sys

NVRTC_SUCCESS = 0


def candidates(explicit):
    """Where an nvrtc DLL might be, most specific first."""
    if explicit:
        yield explicit

    roots = []
    for var in ("CUDA_PATH", "CUDA_HOME"):
        if os.environ.get(var):
            roots.append(os.environ[var])
    # The toolkit puts the runtime DLLs in bin/x64 and older layouts in bin.
    for root in roots:
        for sub in ("bin/x64", "bin", "lib/x64"):
            for pattern in ("nvrtc64_*.dll", "libnvrtc.so*", "libnvrtc.dylib"):
                yield from sorted(glob.glob(os.path.join(root, sub, pattern)), reverse=True)

    # A bare name lets the loader use the search path, which covers a toolkit on PATH and
    # every Linux install.
    for bare in ("nvrtc64_130_0.dll", "nvrtc64_120_0.dll", "libnvrtc.so", "nvrtc"):
        yield bare


def load(explicit):
    tried = []
    for name in candidates(explicit):
        if name in tried:
            continue
        tried.append(name)
        try:
            return ctypes.CDLL(name), name
        except OSError:
            continue
    sys.stderr.write(
        "could not load the NVRTC library. Looked for: %s\n"
        "It ships with the CUDA Toolkit as nvrtc64_<version>.dll (bin/x64 on Windows). "
        "Set nvIsaExtractor.compile.nvrtcPath to one, or set CUDA_PATH.\n"
        % ", ".join(tried[:6]))
    return None, None


def compile_to_ptx(dll, source_path, options):
    with open(source_path, "rb") as handle:
        source = handle.read()

    prog = ctypes.c_void_p()
    # The absolute path, not the basename. This name is what NVRTC writes into the PTX `.file`
    # record, and anything relative is later resolved against whatever directory the *editor*
    # happens to be running in - which produced a source map pointing at a file that does not
    # exist. It is also what the correlation UI matches against the open document.
    name = os.path.abspath(source_path).encode("utf-8")
    rc = dll.nvrtcCreateProgram(ctypes.byref(prog), source, name, 0, None, None)
    if rc != NVRTC_SUCCESS:
        return None, "nvrtcCreateProgram failed (%d)" % rc

    encoded = [o.encode("utf-8") for o in options]
    argv = (ctypes.c_char_p * len(encoded))(*encoded) if encoded else None
    rc = dll.nvrtcCompileProgram(prog, len(encoded), argv)

    size = ctypes.c_size_t()
    dll.nvrtcGetProgramLogSize(prog, ctypes.byref(size))
    log = ""
    if size.value > 1:
        buf = ctypes.create_string_buffer(size.value)
        dll.nvrtcGetProgramLog(prog, buf)
        log = buf.value.decode("utf-8", "replace")

    if rc != NVRTC_SUCCESS:
        return None, log or ("nvrtcCompileProgram failed (%d)" % rc)

    dll.nvrtcGetPTXSize(prog, ctypes.byref(size))
    buf = ctypes.create_string_buffer(size.value)
    dll.nvrtcGetPTX(prog, buf)
    return buf.value, log


def main(argv):
    if len(argv) != 2:
        sys.stderr.write(__doc__)
        return 2

    # `--probe` is what the doctor command runs: load the library, say which one and what
    # version, compile nothing. It has to be answerable without a source file to hand.
    probe = argv[1] == "--probe"
    request = {}
    if not probe:
        with open(argv[1], "r", encoding="utf-8") as handle:
            request = json.load(handle)

    dll, which = load(request.get("nvrtc"))
    if dll is None:
        return 2

    major, minor = ctypes.c_int(), ctypes.c_int()
    dll.nvrtcVersion(ctypes.byref(major), ctypes.byref(minor))
    sys.stdout.write("nvrtc %d.%d from %s\n" % (major.value, minor.value, which))
    if probe:
        return 0

    ptx, log = compile_to_ptx(dll, request["source"], request.get("options") or [])
    # Warnings are worth keeping even on success - they are the only place a deprecation or a
    # silently ignored option is mentioned.
    if log:
        sys.stdout.write(log if log.endswith("\n") else log + "\n")
    if ptx is None:
        return 1

    with open(request["output"], "wb") as handle:
        handle.write(ptx)
    sys.stdout.write("wrote %d bytes of PTX\n" % len(ptx))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
