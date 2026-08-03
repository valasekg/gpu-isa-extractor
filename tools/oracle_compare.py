#!/usr/bin/env python3
"""Hold the extension's JavaScript cache reader to the reference Python one.

    py tools/oracle_compare.py --quick     # large objects only, seconds
    py tools/oracle_compare.py --full      # every backend and mode, plus byte identity

The container format is reverse-engineered and undocumented, so "the port is correct" cannot
be argued from a specification - there isn't one. What can be established is that two
independent implementations agree, on this machine's real caches, down to the sha1 of every
carved object and the bytes of the disassembly that comes out the other end.

The reference lives in the csg-propagation repo (tools/nvsass). Point NVSASS_ORACLE at it if
it is somewhere else. Without it, and without a shader cache to read, this reports SKIP - it
is a machine-specific check, not something a fresh clone can run.

What is compared:

  1. object sets      (source, offset, sha1, code_bytes, entry) from both readers, per
                      backend and mode. A set, not a list: the two order their sweeps
                      differently and neither order is meaningful.
  2. carve identity   the raw microcode both readers extract for the same object.
  3. disassembly      nvdisasm's output on both carves, byte for byte after newline
                      normalisation (Python writes LF; nvdisasm emits CRLF on Windows).
  4. the tripwire     across every annotated instruction: the reuse bits this extension
                      decodes must agree with the `.reuse` flags nvdisasm printed from its
                      own decoding of the same word. This is the only evidence that the
                      21-bit control window is placed correctly, so it is reported as a
                      count over the whole corpus rather than a pass/fail on one object.
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))
DEFAULT_ORACLE = r"D:\Development\Repositories\csg-propagation\tools\nvsass"

failures = []
passes = 0
skips = []


def ok(msg, detail=""):
    global passes
    passes += 1
    print("  ok    %s" % msg)
    if detail:
        print("        %s" % detail)


def bad(msg, detail=""):
    failures.append(msg)
    print("  FAIL  %s" % msg)
    if detail:
        for line in str(detail).splitlines()[:20]:
            print("        %s" % line)


def skip(msg):
    skips.append(msg)
    print("  skip  %s" % msg)


def find_node():
    """A real Node if there is one, otherwise VS Code's Electron in Node mode."""
    from shutil import which
    node = which("node")
    if node:
        return [node], dict(os.environ)
    candidates = [
        os.environ.get("VSCODE_EXE"),
        r"D:\Development\Programs\Microsoft VS Code\Code.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"),
        r"C:\Program Files\Microsoft VS Code\Code.exe",
    ]
    for exe in candidates:
        if exe and os.path.exists(exe):
            env = dict(os.environ)
            env["ELECTRON_RUN_AS_NODE"] = "1"
            return [exe], env
    return None, None


NODE, NODE_ENV = find_node()
ORACLE = os.environ.get("NVSASS_ORACLE", DEFAULT_ORACLE)


def run_json(cmd, env=None, allow_empty=True):
    """Run a command that prints JSON on stdout. Exit 1 means "no objects", not an error."""
    proc = subprocess.run(cmd, env=env, cwd=ROOT, capture_output=True, text=True)
    if proc.returncode not in (0, 1) or not proc.stdout.strip():
        return None, "exit %d\n%s" % (proc.returncode, (proc.stderr or "")[:400])
    if proc.returncode == 1 and not allow_empty:
        return None, "no objects"
    try:
        return json.loads(proc.stdout), None
    except json.JSONDecodeError as e:
        return None, "%s\n%s" % (e, proc.stdout[:400])


def ours(*args):
    return run_json(NODE + [os.path.join(ROOT, "tools", "dump_objects.js")] + list(args),
                    env=NODE_ENV)


def theirs(*args):
    return run_json([sys.executable or "py", os.path.join(ORACLE, "nvsass.py")] + list(args))


def key_set(objects):
    """Identity of an object, as both readers report it."""
    return {(os.path.normcase(os.path.abspath(o["source"])), o["offset"],
             o["microcode_sha1"], o["code_bytes"], o["entry"] or None) for o in objects}


def describe(diff, limit=5):
    return "\n".join("%s @%d  %d B  %s  %s" % (os.path.basename(s), off, size, sha[:8], name)
                     for s, off, sha, size, name in sorted(diff, key=lambda k: -k[3])[:limit])


def compare_sets(label, our_args, their_args):
    """Both readers sweep the same cache the same way; the object sets must be equal."""
    a, err_a = ours(*our_args)
    if err_a:
        bad("%s: this extension's reader failed" % label, err_a)
        return None
    b, err_b = theirs(*their_args)
    if err_b:
        bad("%s: the reference reader failed" % label, err_b)
        return None

    mine, ref = key_set(a["objects"]), key_set(b["objects"])
    if mine == ref:
        ok("%s: %d objects, identical to the reference" % (label, len(mine)))
        return a
    only_mine, only_ref = mine - ref, ref - mine
    bad("%s: object sets differ (%d only here, %d only in the reference)"
        % (label, len(only_mine), len(only_ref)),
        ("only here:\n%s\n" % describe(only_mine) if only_mine else "") +
        ("only in the reference:\n%s" % describe(only_ref) if only_ref else ""))
    return a


def normalise(text):
    """nvdisasm emits CRLF on Windows; the reference writes its output through Python text
    mode, which lands as LF. Comparing raw bytes would report every line as different."""
    return text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")


def disassemble(raw_path, arch, nvdisasm):
    proc = subprocess.run([nvdisasm, "--binary", arch, "--no-dataflow", raw_path],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return None, (proc.stderr or "")[:400]
    return normalise(proc.stdout), None


def resolve_nvdisasm():
    from shutil import which
    exe = which("nvdisasm")
    if exe:
        return exe
    cuda = os.environ.get("CUDA_PATH")
    if cuda:
        candidate = os.path.join(cuda, "bin", "nvdisasm.exe")
        if os.path.exists(candidate):
            return candidate
    return None


def detect_arch():
    from shutil import which
    if not which("nvidia-smi"):
        return None
    proc = subprocess.run(["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    major, _, minor = proc.stdout.strip().splitlines()[0].strip().partition(".")
    return "SM%s%s" % (major, minor)


def compare_object(obj, arch, nvdisasm, tmpdir):
    """One object, carved by both readers and disassembled from both carves."""
    label = "%s @%d (%s, %d B)" % (os.path.basename(obj["source"]), obj["offset"],
                                   obj["entry"] or "unnamed", obj["code_bytes"])
    mine_raw = os.path.join(tmpdir, "ours_%s.bin" % obj["microcode_sha1"][:12])
    ref_raw = os.path.join(tmpdir, "ref_%s.bin" % obj["microcode_sha1"][:12])

    a, err = ours("dump", "--source", obj["source"], "--offset", str(obj["offset"]),
                  "--raw", mine_raw, "--json")
    if err:
        bad("%s: this extension could not re-carve it" % label, err)
        return None
    # The reference matches --source against the basename, not the whole path.
    b, err = theirs("dump", "--source", os.path.basename(obj["source"]),
                    "--offset", str(obj["offset"]),
                    "--raw", ref_raw, "-o", os.path.join(tmpdir, "ref.sass"), "--json")
    if err:
        bad("%s: the reference could not carve it" % label, err)
        return None

    ref_sha = (b.get("object") or {}).get("microcode_sha1")
    if a["microcode_sha1"] != ref_sha:
        bad("%s: the two carves differ" % label, "%s vs %s" % (a["microcode_sha1"], ref_sha))
        return None
    with open(mine_raw, "rb") as f:
        mine_bytes = f.read()
    with open(ref_raw, "rb") as f:
        ref_bytes = f.read()
    if mine_bytes != ref_bytes:
        bad("%s: the carved bytes differ despite matching hashes" % label)
        return None
    ok("%s: carved byte-for-byte identically" % label)

    if not (arch and nvdisasm):
        return None
    mine_text, err = disassemble(mine_raw, arch, nvdisasm)
    if err:
        bad("%s: nvdisasm failed on this extension's carve" % label, err)
        return None
    ref_text, err = disassemble(ref_raw, arch, nvdisasm)
    if err:
        bad("%s: nvdisasm failed on the reference carve" % label, err)
        return None
    if mine_text != ref_text:
        bad("%s: the disassembly differs" % label)
        return None
    ok("%s: disassembles identically (%d lines)" % (label, mine_text.count("\n")))

    # The tripwire runs over files, not arguments: these listings reach tens of megabytes.
    listing = os.path.join(tmpdir, "ours_%s.sass" % obj["microcode_sha1"][:12])
    with open(listing, "w", encoding="utf-8", newline="\n") as f:
        f.write(mine_text)
    return mine_raw, listing


def check_tripwire(samples):
    """The reuse bits this extension decodes, against the `.reuse` flags nvdisasm printed.

    Both come from the same 128-bit word, decoded independently. Agreement across a large
    corpus is the evidence that the control-field window is where this thinks it is.
    """
    if not samples:
        skip("reuse tripwire: no disassembly to check")
        return
    script = os.path.join(ROOT, "tools", "check_tripwire.js")
    with open(script, "w", encoding="utf-8") as f:
        f.write(TRIPWIRE_JS)
    try:
        proc = subprocess.run(NODE + [script] + [p for pair in samples for p in pair],
                              env=NODE_ENV, cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            bad("reuse tripwire could not run", (proc.stderr or proc.stdout)[:400])
            return
        result = json.loads(proc.stdout)
        if result["mismatches"] == 0:
            ok("reuse tripwire clean across %d instructions in %d object(s)"
               % (result["instructions"], result["objects"]),
               "the decoded control window agrees with nvdisasm on every instruction")
        else:
            bad("reuse tripwire fired on %d of %d instructions"
                % (result["mismatches"], result["instructions"]),
                "the control-field layout may differ on this architecture:\n%s"
                % json.dumps(result["examples"][:5]))
    finally:
        if os.path.exists(script):
            os.unlink(script)


TRIPWIRE_JS = r"""'use strict';
// Written and removed by oracle_compare.py; runs the extension's own annotator over the
// listings it just produced and reports how often the tripwire fires.
const fs = require('fs');
const path = require('path');
const ctrl = require(path.join(__dirname, '..', 'src', 'ctrl.js'));
let instructions = 0, mismatches = 0, objects = 0;
const examples = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const microcode = fs.readFileSync(args[i]);
  const text = fs.readFileSync(args[i + 1], 'utf8');
  const r = ctrl.annotate(text, microcode);
  objects++;
  instructions += r.annotated;
  mismatches += r.mismatchTotal;
  for (const m of r.mismatches.slice(0, 3)) examples.push({ object: path.basename(args[i]), ...m });
}
process.stdout.write(JSON.stringify({ objects, instructions, mismatches, examples }));
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true",
                    help="large GLCache objects only (seconds)")
    ap.add_argument("--full", action="store_true",
                    help="every backend and mode, plus byte identity (minutes)")
    ap.add_argument("--objects", type=int, default=3,
                    help="how many objects to compare byte-for-byte (default 3)")
    args = ap.parse_args()
    if not args.quick and not args.full:
        args.quick = True

    print("\noracle comparison")
    print("  this      %s" % ROOT)
    print("  reference %s" % ORACLE)

    if not NODE:
        print("\nSKIP  no JavaScript runtime found (set VSCODE_EXE, or install Node)")
        return 0
    if not os.path.exists(os.path.join(ORACLE, "nvsass.py")):
        print("\nSKIP  the reference reader is not on this machine")
        print("      expected %s" % os.path.join(ORACLE, "nvsass.py"))
        print("      set NVSASS_ORACLE to point at a csg-propagation tools/nvsass checkout")
        return 0

    nvdisasm = resolve_nvdisasm()
    arch = detect_arch()
    print("  nvdisasm  %s" % (nvdisasm or "not found - disassembly comparison skipped"))
    print("  arch      %s" % (arch or "unknown - disassembly comparison skipped"))

    print("\n1. Object sets")
    floor = "2000000" if args.quick else "0"
    listing = compare_sets("GLCache, indexed, min-code %s" % floor,
                           ["list", "--backend", "vk", "--min-code", floor, "--json"],
                           ["list", "--backend", "vk", "--min-code", floor, "--json", "--all"])

    if args.full:
        compare_sets("GLCache, magic scan",
                     ["list", "--backend", "vk", "--scan", "--min-code", "2000000", "--json"],
                     ["list", "--backend", "vk", "--scan", "--min-code", "2000000",
                      "--json", "--all"])
        compare_sets("DXCache, min-code 65536",
                     ["list", "--backend", "dx", "--min-code", "65536", "--json"],
                     ["list", "--backend", "dx", "--min-code", "65536", "--json", "--all"])

    if not listing or not listing["objects"]:
        skip("no objects to compare byte-for-byte")
    else:
        print("\n2. Byte identity")
        import tempfile
        tmpdir = tempfile.mkdtemp(prefix="nvisa_oracle_")
        chosen = sorted(listing["objects"], key=lambda o: -o["code_bytes"])[:args.objects]
        samples = []
        try:
            for obj in chosen:
                result = compare_object(obj, arch, nvdisasm, tmpdir)
                if result:
                    samples.append(result)
            print("\n3. Reuse tripwire")
            check_tripwire(samples)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    print("\n" + "-" * 70)
    print("%s   %d passed, %d failed, %d skipped"
          % ("PASS" if not failures else "FAIL", passes, len(failures), len(skips)))
    for f in failures:
        print("  - %s" % f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
