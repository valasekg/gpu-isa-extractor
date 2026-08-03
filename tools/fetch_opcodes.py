#!/usr/bin/env python3
"""Regenerate data/opcodes.json from NVIDIA's CUDA Binary Utilities documentation.

That page is the only *first-party* SASS opcode reference NVIDIA publishes. It carries one
table per architecture (Turing, Ampere+Ada, Hopper, Blackwell); inside each table, category
names appear as <strong> group rows rather than as headings, which is why this parses the
table bodies rather than the document outline.

    py tools/fetch_opcodes.py                 # fetch and regenerate
    py tools/fetch_opcodes.py --html f.html   # parse a local copy instead
    py tools/fetch_opcodes.py --check         # regenerate into memory, diff, exit 1 if stale

The generated file is checked in so the extension has no build step and no network
dependency; this script exists so that the provenance is reproducible rather than asserted.
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.request
from collections import OrderedDict

DOC_URL = "https://docs.nvidia.com/cuda/cuda-binary-utilities/index.html"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "data", "opcodes.json")

# Section heading -> short architecture key used by the extension.
ARCH_KEYS = [
    (re.compile(r"\bTuring\b", re.I), "turing"),
    (re.compile(r"\bAmpere\b", re.I), "ampere"),
    (re.compile(r"\bHopper\b", re.I), "hopper"),
    (re.compile(r"\bBlackwell\b", re.I), "blackwell"),
]


def strip_tags(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def arch_key(heading):
    for rx, key in ARCH_KEYS:
        if rx.search(heading):
            return key
    return None


def parse(src):
    """Walk headings and tables in document order, attributing each table to its section."""
    tokens = []
    for m in re.finditer(r"<h([1-6])[^>]*>(.*?)</h\1>|<table[^>]*>(.*?)</table>", src, re.S):
        if m.group(1):
            tokens.append(("h", strip_tags(m.group(2)).rstrip("#").strip()))
        else:
            tokens.append(("t", m.group(3)))

    opcodes = {}
    order = []
    cur_arch = None
    for kind, payload in tokens:
        if kind == "h":
            if re.search(r"Instruction Set", payload, re.I):
                cur_arch = arch_key(payload)
            continue
        if not cur_arch:
            continue

        cat = None
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", payload, re.S):
            cells = [strip_tags(c) for c in
                     re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
            strongs = [strip_tags(s) for s in re.findall(r"<strong>(.*?)</strong>", row, re.S)]
            # A category row carries one <strong> label and no second column.
            if strongs and len([c for c in cells if c]) == 1:
                cat = re.sub(r"\s+Instructions?$", "", strongs[0])
                continue
            if len(cells) < 2:
                continue
            op, desc = cells[0], cells[1]
            if not op or op.lower() == "opcode":
                continue
            if not re.fullmatch(r"[A-Z][A-Z0-9_.]*", op):
                continue
            e = opcodes.get(op)
            if e is None:
                e = opcodes[op] = {"desc": desc, "cat": cat or "Miscellaneous", "archs": []}
                order.append(op)
            # Later tables are newer architectures; prefer their (usually fuller) wording.
            if len(desc) > len(e["desc"]):
                e["desc"] = desc
            if cat and e["cat"] == "Miscellaneous":
                e["cat"] = cat
            if cur_arch not in e["archs"]:
                e["archs"].append(cur_arch)

    return opcodes, order


def build(src):
    opcodes, _ = parse(src)
    if len(opcodes) < 200:
        raise SystemExit("refusing to write: only %d opcodes parsed, the page layout probably "
                         "changed" % len(opcodes))

    ver = re.search(r"<span>v([\d.]+)\s*\|</span>", src)
    doc = OrderedDict()
    doc["_meta"] = OrderedDict([
        ("source", DOC_URL),
        ("docs_version", ver.group(1) if ver else "unknown"),
        ("generated_by", "tools/fetch_opcodes.py"),
        ("opcode_count", len(opcodes)),
        ("note", "First-party opcode list. NVIDIA documents mnemonics only; postfix "
                 "semantics live in data/modifiers.json."),
    ])
    doc["opcodes"] = OrderedDict(
        (op, OrderedDict([("desc", v["desc"]), ("cat", v["cat"]), ("archs", v["archs"])]))
        for op, v in sorted(opcodes.items()))
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="parse this local HTML file instead of fetching")
    ap.add_argument("--check", action="store_true",
                    help="do not write; exit non-zero if data/opcodes.json is out of date")
    args = ap.parse_args()

    if args.html:
        src = open(args.html, encoding="utf-8").read()
    else:
        req = urllib.request.Request(DOC_URL, headers={"User-Agent": "nvidia-sass-highlighter"})
        with urllib.request.urlopen(req, timeout=60) as r:
            src = r.read().decode("utf-8", "replace")

    doc = build(src)
    text = json.dumps(doc, indent=1) + "\n"

    if args.check:
        try:
            cur = open(OUT, encoding="utf-8").read()
        except FileNotFoundError:
            cur = None
        if cur != text:
            print("data/opcodes.json is out of date; re-run without --check")
            return 1
        print("data/opcodes.json is up to date (%d opcodes)" % doc["_meta"]["opcode_count"])
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)

    by_arch = {}
    for v in doc["opcodes"].values():
        for a in v["archs"]:
            by_arch[a] = by_arch.get(a, 0) + 1
    print("wrote %s" % os.path.normpath(OUT))
    print("  %d unique opcodes from docs %s" % (doc["_meta"]["opcode_count"],
                                                doc["_meta"]["docs_version"]))
    print("  per architecture: %s" % ", ".join("%s=%d" % kv for kv in sorted(by_arch.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
