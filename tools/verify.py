#!/usr/bin/env python3
"""Verify the extension without a Node toolchain.

    py tools/verify.py

Checks, in order:

  1. every JSON file parses and carries the keys the code expects
  2. every grammar regex compiles
  3. the manifest, the grammar, the themes and the JS agree with one another
  4. the parser/data and hover-provider JavaScript suites pass

Step 4 needs a JS runtime. There is no Node on this machine, but VS Code ships one inside
Electron and this finds it; if it cannot, the step is reported as skipped rather than
silently passing.

Caveat worth remembering: VS Code runs TextMate grammars under Oniguruma, and step 2
compiles them under Python's `re`. The two agree on the constructs used here, but this is
an approximation, not a proof - the visual pass in the editor is what confirms it.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

failures = []
warnings = []
passes = 0


def ok(msg):
    global passes
    passes += 1
    print("  ok    %s" % msg)


def bad(msg, detail=""):
    failures.append(msg)
    print("  FAIL  %s" % msg)
    if detail:
        for line in str(detail).splitlines():
            print("        %s" % line)


def warn(msg, detail=""):
    warnings.append(msg)
    print("  warn  %s" % msg)
    if detail:
        for line in str(detail).splitlines():
            print("        %s" % line)


def rel(*parts):
    return os.path.join(ROOT, *parts)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------- 1. JSON lint

print("\n1. JSON files")

JSON_FILES = [
    "package.json", "language-configuration.json",
    "syntaxes/sass.tmLanguage.json",
    "themes/sass-dark-color-theme.json", "themes/sass-light-color-theme.json",
    "data/opcodes.json", "data/opcodes-extra.json",
    "data/modifiers.json", "data/registers.json",
]

docs = {}
for name in JSON_FILES:
    path = rel(*name.split("/"))
    if not os.path.exists(path):
        bad("%s is missing" % name)
        continue
    try:
        docs[name] = load_json(path)
        ok("%s parses" % name)
    except Exception as e:                                     # noqa: BLE001
        bad("%s does not parse" % name, e)

if len(docs) != len(JSON_FILES):
    print("\naborting: cannot continue without every JSON file")
    sys.exit(1)

manifest = docs["package.json"]
grammar = docs["syntaxes/sass.tmLanguage.json"]
opcodes = docs["data/opcodes.json"]
extra = docs["data/opcodes-extra.json"]
modifiers = docs["data/modifiers.json"]
registers = docs["data/registers.json"]

# Required shape, so a hand-edit that drops a key fails here and not at runtime.
print("\n2. Data shape")

if opcodes.get("_meta", {}).get("opcode_count") == len(opcodes.get("opcodes", {})):
    ok("opcodes.json count matches its metadata (%d)" % len(opcodes["opcodes"]))
else:
    bad("opcodes.json _meta.opcode_count disagrees with the table",
        "meta=%s actual=%d" % (opcodes.get("_meta", {}).get("opcode_count"),
                               len(opcodes.get("opcodes", {}))))

missing_fields = [n for n, e in opcodes["opcodes"].items()
                  if not all(k in e for k in ("desc", "cat", "archs"))]
if missing_fields:
    bad("opcodes.json entries missing desc/cat/archs", " ".join(missing_fields[:10]))
else:
    ok("every opcode entry has desc, cat and archs")

if extra.get("_meta", {}).get("opcode_count") == len(extra.get("opcodes", {})):
    ok("opcodes-extra.json count matches its metadata (%d)" % len(extra["opcodes"]))
else:
    bad("opcodes-extra.json _meta.opcode_count disagrees with the table")

VALID_SOURCES = set(modifiers["_meta"]["sources"])
bad_sources = []
mod_count = 0
for name, entry in modifiers["generic"].items():
    mod_count += 1
    if entry.get("source") not in VALID_SOURCES:
        bad_sources.append("generic.%s" % name)
for gname, group in modifiers["groups"].items():
    if "opcodes" not in group or "mods" not in group:
        bad("modifier group %s is missing opcodes/mods" % gname)
    for name, entry in group.get("mods", {}).items():
        mod_count += 1
        if entry.get("source") not in VALID_SOURCES:
            bad_sources.append("%s.%s" % (gname, name))
if bad_sources:
    bad("modifier entries with an unknown `source`", " ".join(bad_sources[:10]))
else:
    ok("every modifier entry (%d) declares a known source" % mod_count)

# Group opcodes should be real opcodes, otherwise the group silently never applies.
known_opcodes = set(opcodes["opcodes"]) | set(extra["opcodes"])
ghost = sorted({op for g in modifiers["groups"].values() for op in g["opcodes"]
                if op not in known_opcodes and not (op.startswith("U") and op[1:] in known_opcodes)})
if ghost:
    warn("modifier groups reference opcodes not in any opcode table", " ".join(ghost))
else:
    ok("every opcode named by a modifier group exists")

for spec_name, era in (("controlCode", "Maxwell"), ("controlCodeVolta", "Volta+")):
    cc = registers.get(spec_name, {})
    if not cc:
        bad("registers.json is missing the %s control-code spec (%s)" % (era, spec_name))
    elif set(cc.get("fieldOrder", [])) == set(cc.get("fields", {})):
        ok("%s control-code fieldOrder and fields agree" % era)
    else:
        bad("%s control-code fieldOrder does not match the fields table" % era)

# The parser names the five fields; the hover looks them up in these tables by that name.
PARSER_FIELDS = ["wait", "read", "write", "yield", "stall"]
mismatched = [n for n in ("controlCode", "controlCodeVolta")
              if registers.get(n, {}).get("fieldOrder") != PARSER_FIELDS]
if mismatched:
    bad("control-code fieldOrder disagrees with the parser's field names",
        " ".join(mismatched))
else:
    ok("both control-code specs use the parser's field names in printed order")

# ------------------------------------------------------------- 3. grammar re

print("\n3. Grammar regexes")


def walk_regexes(node, path="$"):
    if isinstance(node, dict):
        for key in ("match", "begin", "end", "while"):
            if isinstance(node.get(key), str):
                yield "%s.%s" % (path, key), node[key]
        for k, v in node.items():
            yield from walk_regexes(v, "%s.%s" % (path, k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_regexes(v, "%s[%d]" % (path, i))


regex_count = 0
regex_bad = 0
for where, pattern in walk_regexes(grammar):
    regex_count += 1
    try:
        re.compile(pattern)
    except re.error as e:
        regex_bad += 1
        bad("grammar regex does not compile at %s" % where, "%s\n%s" % (e, pattern))
if regex_bad == 0:
    ok("all %d grammar regexes compile (Python re; Oniguruma is the real engine)" % regex_count)

# A control column and its instruction start at the same position. The instruction rule must
# consume both; otherwise TextMate matches the standalone control-column rule first and can
# never reach the opcode because the instruction rule is line-anchored.
instruction_rule = grammar["repository"]["instruction"]
instruction_re = re.compile(instruction_rule["begin"])
opcode_capture = 28

if (instruction_rule["beginCaptures"].get(str(opcode_capture), {}).get("name")
        == "keyword.other.opcode.sass"):
    ok("the instruction rule scopes capture %d as the opcode" % opcode_capture)
else:
    bad("capture %d is not the opcode - the begin regex and beginCaptures have drifted apart"
        % opcode_capture)

# Every prefix form has to leave the opcode in the same capture, or the renumbering broke one
# of them. The bracketed column is the one this extension emits; the rest are inputs it reads.
PREFIX_FORMS = [
    ("no prefix", "        ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
    ("Maxwell control column", "01:-:-:Y:d      ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
    ("nvdisasm address", "        /*0130*/ ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
    ("Nsight address", "0x0000000300000030  ISETP.GE.AND P0, PT, R0, 0x80, PT", "ISETP"),
    ("Volta+ control column",
     "        /*0130*/ [B--2---:R-:W0:Y:S04]  ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
    ("Volta+ control column with guard",
     "        /*0310*/ [B------:R-:W-:-:S01]  @!P0 BRA 0x3a0 ;", "BRA"),
    ("Volta+ control column, no address",
     "[B0-----:R1:W-:Y:S12]  IADD3 R2, R3, R4, RZ ;", "IADD3"),
]
lost = []
for label, line, expected in PREFIX_FORMS:
    m = instruction_re.match(line)
    if not m or m.group(opcode_capture) != expected:
        lost.append("%s -> %s (expected %s)"
                    % (label, m.group(opcode_capture) if m else "no match", expected))
if lost:
    bad("the instruction rule loses the opcode after some line prefixes", "\n".join(lost))
else:
    ok("the instruction rule keeps the opcode in capture %d across all %d line prefixes"
       % (opcode_capture, len(PREFIX_FORMS)))

# The Volta+ column's five value captures must land on the control-code scopes, otherwise the
# column renders as punctuation and the era distinction is invisible.
VOLTA_FIELD_CAPTURES = {
    15: ("wait-barrier", "B--2---"), 17: ("read-barrier", "R-"),
    19: ("write-barrier", "W0"), 21: ("yield", "Y"), 23: ("stall", "S04"),
}
volta_match = instruction_re.match(PREFIX_FORMS[4][1])          # the bracketed-column sample
wrong = []
for group, (scope_leaf, text) in VOLTA_FIELD_CAPTURES.items():
    scope = instruction_rule["beginCaptures"].get(str(group), {}).get("name", "")
    if not scope.startswith("constant.other.control-code.%s" % scope_leaf):
        wrong.append("capture %d is scoped %r" % (group, scope))
    elif volta_match and volta_match.group(group) != text:
        wrong.append("capture %d matched %r, expected %r"
                     % (group, volta_match.group(group), text))
if wrong:
    bad("the Volta+ control column's fields are mis-captured or mis-scoped", "\n".join(wrong))
else:
    ok("the Volta+ control column captures and scopes all five fields")

# The parser and the grammar have to agree on the column's shape, or highlight and hover drift.
parse_src = open(rel("src", "parse.js"), encoding="utf-8").read()
if re.search(r"CONTROL_COLUMN_VOLTA_RE\s*=\s*/\^\\\[\(B\[0-5-\]\{6\}\)", parse_src):
    ok("parse.js recognises the same bracketed control column the grammar does")
else:
    bad("parse.js has no CONTROL_COLUMN_VOLTA_RE matching the grammar's column shape")

# Also check the language-configuration and firstLine patterns.
for where, pattern in [("languages[0].firstLine",
                        manifest["contributes"]["languages"][0].get("firstLine", ""))]:
    if not pattern:
        continue
    try:
        re.compile(pattern)
        ok("%s compiles" % where)
    except re.error as e:
        bad("%s does not compile" % where, e)

# ------------------------------------------------------- 4. manifest wiring

print("\n4. Manifest wiring")

contributes = manifest["contributes"]

referenced = [manifest["main"], contributes["languages"][0]["configuration"]]
referenced += [g["path"] for g in contributes["grammars"]]
referenced += [t["path"] for t in contributes["themes"]]
for path in referenced:
    full = rel(*path.lstrip("./").split("/"))
    if os.path.exists(full):
        ok("manifest references an existing file: %s" % path)
    else:
        bad("manifest references a missing file: %s" % path)

for name in ("README.md", "LICENSE", "tools/package_vsix.py"):
    if os.path.exists(rel(*name.split("/"))):
        ok("release artifact exists: %s" % name)
    else:
        bad("release artifact is missing: %s" % name)

hover_detail = contributes.get("configuration", {}).get("properties", {}).get(
    "nvidiaSass.hover.detail", {})
if (hover_detail.get("default") == "concise"
        and hover_detail.get("enum") == ["concise", "elaborate"]
        and hover_detail.get("enumItemLabels") == ["Concise", "Elaborate"]):
    ok("hover detail setting declares concise and elaborate modes")
else:
    bad("hover detail setting is missing or malformed")

declared_types = {t["id"] for t in contributes["semanticTokenTypes"]}
declared_mods = {m["id"] for m in contributes["semanticTokenModifiers"]}

semantic_src = open(rel("src", "semantic.js"), encoding="utf-8").read()


def js_array(name):
    m = re.search(r"const %s = \[(.*?)\];" % name, semantic_src, re.S)
    return set(re.findall(r"'([^']+)'", m.group(1))) if m else set()


js_types = js_array("TOKEN_TYPES")
js_mods = js_array("TOKEN_MODIFIERS")

if js_types and js_types <= declared_types:
    ok("every semantic token type the provider emits is declared (%d)" % len(js_types))
else:
    bad("semantic token types emitted but not declared in package.json",
        " ".join(sorted(js_types - declared_types)))

if js_mods and js_mods <= declared_mods:
    ok("every semantic token modifier the provider emits is declared (%d)" % len(js_mods))
else:
    bad("semantic token modifiers emitted but not declared in package.json",
        " ".join(sorted(js_mods - declared_mods)))

scope_map = contributes["semanticTokenScopes"][0]["scopes"]
scope_types = {selector.split(".")[0] for selector in scope_map}
undeclared = scope_types - declared_types
if undeclared:
    bad("semanticTokenScopes names an undeclared type", " ".join(sorted(undeclared)))
else:
    ok("semanticTokenScopes only names declared types")

unmapped = declared_types - scope_types
if unmapped:
    warn("declared semantic types with no TextMate fallback scope", " ".join(sorted(unmapped)))
else:
    ok("every semantic type has a TextMate fallback scope")

required_fallbacks = {
    "sassModifier.tier1",
    "sassModifier.tier2",
    "sassModifier.tier3",
}
for token_type in ("sassVectorReg", "sassUniformReg", "sassPredicate",
                   "sassUniformPredicate"):
    required_fallbacks.update("%s.%s" % (token_type, role)
                              for role in ("dst", "src", "discard"))
required_fallbacks.update(("sassBarrier.dst", "sassBarrier.src"))
missing_fallbacks = required_fallbacks - set(scope_map)
if missing_fallbacks:
    bad("semantic token modifier combinations lack TextMate fallbacks",
        " ".join(sorted(missing_fallbacks)))
else:
    ok("every emitted semantic modifier combination has a TextMate fallback")

# ------------------------------------------------------------- 5. theme cover

print("\n5. Theme coverage")

grammar_scopes = set()
for node_scopes in re.findall(r'"(?:name|contentName)"\s*:\s*"([^"]+)"',
                              open(rel("syntaxes", "sass.tmLanguage.json"), encoding="utf-8").read()):
    if "." in node_scopes:                        # skip the grammar's own display name
        grammar_scopes.add(node_scopes)


def covered_by(scope, rules):
    """TextMate matches by dotted prefix, so `comment` styles `comment.block.address.sass`."""
    parts = scope.split(".")
    for i in range(len(parts), 0, -1):
        if ".".join(parts[:i]) in rules:
            return True
    return False


for theme_name in ("themes/sass-dark-color-theme.json", "themes/sass-light-color-theme.json"):
    theme = docs[theme_name]
    rules = set()
    for rule in theme["tokenColors"]:
        scope = rule["scope"]
        rules.update([scope] if isinstance(scope, str) else scope)

    uncovered = sorted(s for s in grammar_scopes if not covered_by(s, rules))
    if uncovered:
        warn("%s does not style %d grammar scope(s)" % (theme_name, len(uncovered)),
             "\n".join(uncovered))
    else:
        ok("%s styles every one of the %d grammar scopes" % (theme_name, len(grammar_scopes)))

    if theme.get("semanticHighlighting") is True:
        ok("%s enables semanticHighlighting" % theme_name)
    else:
        bad("%s must set semanticHighlighting: true" % theme_name)

    sem_types = {k.split(".")[0] for k in theme.get("semanticTokenColors", {})}
    missing = js_types - sem_types
    if missing:
        warn("%s has no colour for semantic types" % theme_name, " ".join(sorted(missing)))
    else:
        ok("%s colours every semantic token type" % theme_name)

# Keep SASS Light opcodes aligned with VS Code Light+'s C++ keyword palette.
light_theme = docs["themes/sass-light-color-theme.json"]
light_semantic = light_theme.get("semanticTokenColors", {})
light_opcode_textmate = next(
    (rule.get("settings", {}).get("foreground")
     for rule in light_theme.get("tokenColors", [])
     if rule.get("scope") == "keyword.other.opcode.sass"),
    None,
)
if (light_opcode_textmate == "#0000FF"
        and light_semantic.get("sassOpcode", {}).get("foreground") == "#0000FF"):
    ok("SASS Light opcodes match VS Code Light+ C++ keyword colours")
else:
    bad("SASS Light opcode colours drifted from the VS Code Light+ C++ palette")

# --------------------------------------------------------- 6. the JS suites

print("\n6. JavaScript behavior")


def find_node():
    """A real Node if there is one, otherwise VS Code's Electron in Node mode."""
    from shutil import which
    node = which("node")
    if node:
        return [node], {}
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


cmd, env = find_node()
if not cmd:
    warn("no JS runtime found - skipped",
         "Set VSCODE_EXE to a Code.exe, or install Node, to run the JavaScript suites.")
else:
    for script in ("test_parse.js", "test_hover.js", "test_semantic.js", "test_explain.js"):
        proc = subprocess.run(cmd + [rel("tools", script)],
                              env=env, cwd=ROOT, capture_output=True, text=True)
        out = (proc.stdout or "") + (proc.stderr or "")
        for line in out.rstrip().splitlines():
            print("  | %s" % line)
        if proc.returncode == 0:
            ok("%s passed" % script)
        else:
            bad("%s failed (exit %d)" % (script, proc.returncode))

# ------------------------------------------------------------------ summary

print("\n" + "-" * 70)
print("%s   %d passed, %d failed, %d warnings"
      % ("PASS" if not failures else "FAIL", passes, len(failures), len(warnings)))
if failures:
    for f in failures:
        print("  - %s" % f)
sys.exit(1 if failures else 0)
