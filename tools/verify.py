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
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

failures = []
warnings = []
skipped = []
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


def skip(msg):
    """A check that could not run here. Not a pass and not a failure.

    Counted separately so a machine that cannot run a check - no GPU, no cache, no VS Code
    installation to read the stock themes out of - reports honestly rather than either
    claiming the check passed or failing the build for something absent by design.
    """
    skipped.append(msg)
    print("  skip  %s" % msg)


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
VALID_CONFIDENCE = set(modifiers["_meta"].get("confidence", {}))
VALID_REFERENCES = set(modifiers["_meta"].get("references", {}))
bad_sources = []
bad_provenance = []
mod_count = 0


def check_modifier_provenance(label, entry):
    source_ref = entry.get("source_ref")
    confidence = entry.get("confidence")
    targets = entry.get("targets")
    if source_ref and source_ref not in VALID_REFERENCES:
        bad_provenance.append("%s source_ref=%s" % (label, source_ref))
    if confidence and confidence not in VALID_CONFIDENCE:
        bad_provenance.append("%s confidence=%s" % (label, confidence))
    if targets is not None and (not isinstance(targets, list) or not targets or
                                any(not re.fullmatch(r"sm_\d+a?", target)
                                    for target in targets)):
        bad_provenance.append("%s targets=%r" % (label, targets))
    if entry.get("source") == "sass-king" and not (source_ref and confidence and targets):
        bad_provenance.append("%s incomplete SASS King provenance" % label)


for name, entry in modifiers["generic"].items():
    mod_count += 1
    if entry.get("source") not in VALID_SOURCES:
        bad_sources.append("generic.%s" % name)
    check_modifier_provenance("generic.%s" % name, entry)
for gname, group in modifiers["groups"].items():
    if "opcodes" not in group or "mods" not in group:
        bad("modifier group %s is missing opcodes/mods" % gname)
    for name, entry in group.get("mods", {}).items():
        mod_count += 1
        if entry.get("source") not in VALID_SOURCES:
            bad_sources.append("%s.%s" % (gname, name))
        check_modifier_provenance("%s.%s" % (gname, name), entry)
if bad_sources:
    bad("modifier entries with an unknown `source`", " ".join(bad_sources[:10]))
else:
    ok("every modifier entry (%d) declares a known source" % mod_count)

if bad_provenance:
    bad("modifier entries with invalid provenance metadata", " ".join(bad_provenance[:10]))
else:
    ok("modifier provenance references, confidence and targets are valid")

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


# One descriptor per ISA dialect this extension both highlights and parses.
#
# There is one today, and a loop over one entry proves nothing by itself. It is written this
# way because the alternative, when a second ISA arrives, is hand-duplicating eighty lines of
# capture-index arithmetic - and a check that has to be copied to keep covering the code is a
# check that stops covering it. The grammar and the parser are two independent statements about
# the same line format, and this block exists to make them disagree loudly; that value is per
# dialect, so the block is per dialect too.
#
# `opcode_capture` is the load-bearing number. TextMate capture indices are positional, so
# adding one group anywhere in the `begin` regex renumbers everything after it and silently
# moves the opcode somewhere the beginCaptures no longer scope.
DIALECT_GRAMMARS = [
    {
        "label": "NVIDIA SASS",
        "grammar": "syntaxes/sass.tmLanguage.json",
        "parser": ("src", "parse.js"),
        "opcode_capture": 28,
        "opcode_scope": "keyword.other.opcode.sass",
        # Every prefix form has to leave the opcode in the same capture, or the renumbering
        # broke one of them. The bracketed column is the one this extension emits; the rest are
        # inputs it reads.
        "prefix_forms": [
            ("no prefix", "        ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
            ("Maxwell control column",
             "01:-:-:Y:d      ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
            ("nvdisasm address",
             "        /*0130*/ ISETP.GE.AND P0, PT, R0, 0x80, PT ;", "ISETP"),
            ("Nsight address", "0x0000000300000030  ISETP.GE.AND P0, PT, R0, 0x80, PT",
             "ISETP"),
            ("Volta+ control column",
             "        /*0130*/ [B--2---:R-:W0:Y:S04]  ISETP.GE.AND P0, PT, R0, 0x80, PT ;",
             "ISETP"),
            ("Volta+ control column with guard",
             "        /*0310*/ [B------:R-:W-:-:S01]  @!P0 BRA 0x3a0 ;", "BRA"),
            ("Volta+ control column, no address",
             "[B0-----:R1:W-:Y:S12]  IADD3 R2, R3, R4, RZ ;", "IADD3"),
        ],
        # The column's five value captures must land on the control-code scopes, otherwise the
        # column renders as punctuation and the era distinction is invisible.
        #
        # The roots differ per field on purpose. A scope is only coloured by a theme that has a
        # rule matching one of its dot-prefixes, and `constant.other` is not such a rule in the
        # default theme family - dark_vs defines constant.language, constant.numeric,
        # constant.regexp and constant.character but nothing bare enough to catch
        # constant.other. Scoping all five fields under it left the control column at plain
        # foreground in Dark+, Dark Modern, Light+ and both high-contrast themes: 8 of the 19
        # built-in themes, and the most used ones. These roots are styled by 18 or 19 of the 19,
        # and give the column three distinct colours instead of none.
        "column_name": "Volta+ control column",
        "column_sample": "Volta+ control column",         # which prefix form to match against
        "column_captures": {
            15: ("variable.other.control-code.wait-barrier", "B--2---"),
            17: ("variable.other.control-code.read-barrier", "R-"),
            19: ("variable.other.control-code.write-barrier", "W0"),
            21: ("constant.language.control-code.yield", "Y"),
            23: ("constant.numeric.control-code.stall", "S04"),
        },
        # The parser and the grammar have to agree on the column's shape, or highlight and
        # hover drift apart.
        "parser_pattern": r"CONTROL_COLUMN_VOLTA_RE\s*=\s*/\^\\\[\(B\[0-5-\]\{6\}\)",
        "parser_symbol": "CONTROL_COLUMN_VOLTA_RE",
    },
]

regex_count = 0
regex_bad = 0
for dialect in DIALECT_GRAMMARS:
    for where, pattern in walk_regexes(docs[dialect["grammar"]]):
        regex_count += 1
        try:
            re.compile(pattern)
        except re.error as e:
            regex_bad += 1
            bad("grammar regex does not compile at %s (%s)" % (where, dialect["label"]),
                "%s\n%s" % (e, pattern))
if regex_bad == 0:
    ok("all %d grammar regexes compile (Python re; Oniguruma is the real engine)" % regex_count)

for dialect in DIALECT_GRAMMARS:
    label = dialect["label"]
    capture = dialect["opcode_capture"]

    # A control column and its instruction start at the same position. The instruction rule
    # must consume both; otherwise TextMate matches the standalone control-column rule first
    # and can never reach the opcode, because the instruction rule is line-anchored.
    instruction_rule = docs[dialect["grammar"]]["repository"]["instruction"]
    instruction_re = re.compile(instruction_rule["begin"])

    if (instruction_rule["beginCaptures"].get(str(capture), {}).get("name")
            == dialect["opcode_scope"]):
        ok("the %s instruction rule scopes capture %d as the opcode" % (label, capture))
    else:
        bad("capture %d is not the %s opcode - the begin regex and beginCaptures have drifted "
            "apart" % (capture, label))

    lost = []
    for prefix_label, line, expected in dialect["prefix_forms"]:
        m = instruction_re.match(line)
        if not m or m.group(capture) != expected:
            lost.append("%s -> %s (expected %s)"
                        % (prefix_label, m.group(capture) if m else "no match", expected))
    if lost:
        bad("the %s instruction rule loses the opcode after some line prefixes" % label,
            "\n".join(lost))
    else:
        ok("the %s instruction rule keeps the opcode in capture %d across all %d line prefixes"
           % (label, capture, len(dialect["prefix_forms"])))

    # `next(..., None)` and an explicit refusal. A bare `next()` raises StopIteration out of
    # module-level code, which is not a failed check - it is a traceback that kills the run
    # before sections 4, 5 and 6, so the manifest wiring, the theme coverage and all fourteen
    # JS suites report nothing at all and no summary line is printed. This file's own comment
    # elsewhere warns against exactly that ("aborts this whole script instead of failing a
    # check"); a mistyped `column_sample` is the obvious way to reach it.
    sample = next((form for form in dialect["prefix_forms"]
                   if form[0] == dialect["column_sample"]), None)
    if sample is None:
        bad("%s names a column sample that is not one of its prefix forms" % label,
            "column_sample=%r, prefix forms: %s"
            % (dialect["column_sample"], ", ".join(f[0] for f in dialect["prefix_forms"])))
        continue
    column_match = instruction_re.match(sample[1])
    wrong = []
    for group, (expected_scope, text) in dialect["column_captures"].items():
        scope = instruction_rule["beginCaptures"].get(str(group), {}).get("name", "")
        if not scope.startswith(expected_scope):
            wrong.append("capture %d is scoped %r" % (group, scope))
        elif column_match and column_match.group(group) != text:
            wrong.append("capture %d matched %r, expected %r"
                         % (group, column_match.group(group), text))
    if wrong:
        bad("the %s's fields are mis-captured or mis-scoped" % dialect["column_name"],
            "\n".join(wrong))
    else:
        ok("the %s captures and scopes all %d fields"
           % (dialect["column_name"], len(dialect["column_captures"])))

    parser_name = dialect["parser"][-1]
    parse_src = open(rel(*dialect["parser"]), encoding="utf-8").read()
    if re.search(dialect["parser_pattern"], parse_src):
        ok("%s recognises the same control column the %s grammar does" % (parser_name, label))
    else:
        bad("%s has no %s matching the grammar's column shape"
            % (parser_name, dialect["parser_symbol"]))

# A scoreboard slot inside a control column is a bare digit sitting between dashes. Editor
# features that resolve "the word at the cursor" - ctrl+click, double-click, and VS Code's own
# occurrence highlighter - give up entirely when the position is not inside a word, so a word
# pattern that cannot match a lone digit makes `[B01-3--]` behave differently on the `3` than
# on the `01`. That was a real bug; this keeps it from coming back.
word_pattern = docs["language-configuration.json"].get("wordPattern", "")
if word_pattern:
    try:
        wp = re.compile(word_pattern)
        column = "[B01-3--:R-:W0:Y:S01]"
        digit_at = column.index("3")
        covered = any(m.start() <= digit_at < m.end() for m in wp.finditer(column))
        if covered:
            ok("the word pattern covers a lone scoreboard slot in a control column")
        else:
            bad("the word pattern cannot match a lone scoreboard digit",
                "cursor features that resolve a word will skip it in %r" % column)
    except re.error as e:
        bad("wordPattern does not compile", e)

# Also check the language-configuration and firstLine patterns.
#
# Every declared language, resolved by its id rather than by position. `languages[0]` is right
# today because there is one language; the moment there is a second, the check silently stops
# covering it while still reporting a pass - and `firstLine` is what decides whether a listing
# opens as the language that produced it.
for where, pattern in [("languages[%s].firstLine" % lang["id"], lang.get("firstLine", ""))
                       for lang in manifest["contributes"]["languages"]]:
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

referenced = [manifest["main"]]
# Every language's own configuration file, not the first one's. Two languages may legitimately
# point at the SAME file - which is the recommendation for a second ISA dialect - so this is
# de-duplicated rather than assumed distinct.
for lang in contributes["languages"]:
    # A language with no `configuration` is reported, not skipped. The previous `[0]` indexing
    # raised KeyError here - loudly, and for the right reason: a language with no
    # language-configuration has no comment syntax, no brackets and no word pattern, and the
    # word pattern is what makes ctrl+click and double-click work on a lone scoreboard digit.
    # Rewriting the lookup as `.get()` turned that noisy failure into silence.
    if not lang.get("configuration"):
        bad("language %s declares no configuration file" % lang.get("id", "(unnamed)"),
            "without one it has no wordPattern, so cursor features that resolve a word - "
            "ctrl+click, double-click, the occurrence highlighter - stop working inside a "
            "control column.")
    elif lang["configuration"] not in referenced:
        referenced.append(lang["configuration"])
referenced += [g["path"] for g in contributes["grammars"]]
referenced += [t["path"] for t in contributes["themes"]]
for path in referenced:
    full = rel(*path.lstrip("./").split("/"))
    if os.path.exists(full):
        ok("manifest references an existing file: %s" % path)
    else:
        bad("manifest references a missing file: %s" % path)

for name in ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "tools/package_vsix.py",
             "src/vendor/fzstd.js", "src/vendor/fzstd-LICENSE.txt"):
    if os.path.exists(rel(*name.split("/"))):
        ok("release artifact exists: %s" % name)
    else:
        bad("release artifact is missing: %s" % name)

# Every module the extension requires at run time has to ship, or the VSIX installs and then
# fails on first use. Walk the requires rather than trusting a hand-maintained list.
sys.path.insert(0, rel("tools"))
package_vsix = __import__("package_vsix")
shipped = {arc[len("extension/"):] for arc, _ in package_vsix.collect()}
missing_ship = []
# `os.walk`, not `os.listdir`: the latter never descends, so a module in a subdirectory was
# checked as a require TARGET and never as a require SOURCE. `src/vendor/fzstd.js` is exactly
# that - `zstd.js:24` pulls it in, so its existence was proven, but anything it required itself
# was invisible to this check.
walked = sorted(
    os.path.relpath(os.path.join(where, name), rel("src")).replace(os.sep, "/")
    for where, _dirs, names in os.walk(rel("src"))
    for name in names
    if name.endswith(".js")
)
for src_name in walked + ["extension.js"]:
    src_path = rel("src", *src_name.split("/")) if src_name != "extension.js" \
        else rel("extension.js")
    if not src_path.endswith(".js"):
        continue
    base = os.path.dirname(src_path)
    for req in re.findall(r"require\(['\"](\.[^'\"]+)['\"]\)",
                          open(src_path, encoding="utf-8").read()):
        target = os.path.normpath(os.path.join(base, req))
        if not os.path.splitext(target)[1]:
            target += ".js"
        arc = os.path.relpath(target, ROOT).replace(os.sep, "/")
        if not os.path.exists(target):
            missing_ship.append("%s requires %s, which does not exist" % (src_name, req))
        elif arc not in shipped:
            missing_ship.append("%s requires %s, which the VSIX does not ship" % (src_name, arc))
if missing_ship:
    bad("a module required at run time would be missing from the package",
        "\n".join(missing_ship))
else:
    ok("every module required at run time is packaged")

# Commands, their menu entries and their handlers must agree; a typo in any one of them
# produces a command that is visible and does nothing, or invisible and works.
declared_commands = {c["id"] if "id" in c else c["command"]
                     for c in contributes.get("commands", [])}
extension_src = open(rel("extension.js"), encoding="utf-8").read()
registered = set(re.findall(r"registerCommand\(\s*'([^']+)'", extension_src))
if declared_commands and declared_commands == registered:
    ok("every declared command is registered (%d)" % len(declared_commands))
else:
    bad("declared commands and registered handlers disagree",
        "declared only: %s\nregistered only: %s"
        % (" ".join(sorted(declared_commands - registered)) or "-",
           " ".join(sorted(registered - declared_commands)) or "-"))

# A menu entry is either a command or a submenu reference. Indexing ["command"] blindly turns
# a submenu into an uncaught KeyError that aborts this whole script instead of failing a check.
menu_commands = {m["command"] for group in contributes.get("menus", {}).values()
                 for m in group if "command" in m}
if menu_commands <= declared_commands:
    ok("every menu entry names a declared command (%d)" % len(menu_commands))
else:
    bad("a menu entry names an undeclared command",
        " ".join(sorted(menu_commands - declared_commands)))

key_commands = {k["command"].lstrip("-") for k in contributes.get("keybindings", [])
                if "command" in k}
if key_commands <= declared_commands:
    ok("every keybinding names a declared command (%d)" % len(key_commands))
else:
    bad("a keybinding names an undeclared command",
        " ".join(sorted(key_commands - declared_commands)))

# Views, their welcome content and the when-clauses that reference them have to agree, or a
# welcome pane silently never renders and a toolbar button silently never appears.
declared_views = {v["id"] for group in contributes.get("views", {}).values() for v in group}
declared_containers = {c["id"] for group in contributes.get("viewsContainers", {}).values()
                       for c in group}
view_owners = set(contributes.get("views", {}))
unknown_owner = view_owners - declared_containers - {"explorer", "scm", "debug", "test"}
if unknown_owner:
    bad("views contributed to an undeclared container", " ".join(sorted(unknown_owner)))
elif declared_views:
    ok("every view lives in a declared container (%d view(s))" % len(declared_views))

welcome_views = {w["view"] for w in contributes.get("viewsWelcome", [])}
if welcome_views <= declared_views:
    ok("every viewsWelcome entry names a declared view")
else:
    bad("a viewsWelcome entry names an undeclared view",
        " ".join(sorted(welcome_views - declared_views)))

manifest_text = open(rel("package.json"), encoding="utf-8").read()
referenced_views = set(re.findall(r"(?:view|focusedView)\s*==\s*([\w.]+)", manifest_text))
if referenced_views <= declared_views:
    ok("every view named in a when-clause exists")
else:
    bad("a when-clause names a view that is not declared",
        " ".join(sorted(referenced_views - declared_views)))

# Settings are read by string. A rename on one side only is silent: the code keeps reading
# the old name and quietly gets the default forever.
declared_settings = set(contributes.get("configuration", {}).get("properties", {}))
# Discovered rather than listed. A hand-maintained tuple silently omits a new module - and it
# was worse than that: the `os.path.exists` filter that used to follow dropped a misspelt entry
# without a word, so a module could be renamed and its settings would stop being checked while
# the suite still reported a pass. `src/vendor/` is excluded because it is third-party code
# that reads none of this extension's settings.
JS_SOURCES = tuple(
    ["extension.js"] +
    sorted(
        os.path.relpath(os.path.join(where, name), ROOT).replace(os.sep, "/")
        for where, _dirs, names in os.walk(rel("src"))
        if "vendor" not in os.path.relpath(where, ROOT).split(os.sep)
        for name in names
        if name.endswith(".js")
    )
)

# A configuration section is reached either directly (`getConfiguration('x').get('y')`) or
# through a local (`const s = getConfiguration('x'); ... s.get('y')`). Both forms are in use,
# so resolve the locals rather than only matching the chained call.
PIPELINE_SECTION = "nvIsaExtractor"


def settings_read(text):
    found = set()
    bindings = {}                                   # local name -> section
    helpers = {}                                    # zero-arg helper name -> section

    for name, section in re.findall(
            r"(?:const|let|var)\s+(\w+)\s*=\s*(?:vscode\.workspace\.)?"
            r"getConfiguration\(\s*['\"]([\w.]+)['\"]\s*\)", text):
        bindings[name] = section

    # A module that reads several settings usually wraps the lookup:
    #     function settings() { return vscode.workspace.getConfiguration('nvIsaExtractor'); }
    # Resolve those, so the check does not depend on every module naming the helper alike.
    for name, section in re.findall(
            r"function\s+(\w+)\s*\(\s*\)\s*\{\s*return\s+(?:vscode\.workspace\.)?"
            r"getConfiguration\(\s*['\"]([\w.]+)['\"]\s*\)", text):
        helpers[name] = section
    for name in re.findall(
            r"function\s+(\w+)\s*\(\s*\)\s*\{\s*return\s+(?:vscode\.workspace\.)?"
            r"getConfiguration\(\s*[\w.]*CONFIG\s*\)", text):
        helpers[name] = PIPELINE_SECTION
    for name, section in helpers.items():
        for key in re.findall(r"\b%s\(\)\s*\.\s*get\(\s*['\"]([\w.]+)['\"]" % re.escape(name),
                              text):
            found.add("%s.%s" % (section, key))
        # ...and the same helper's result stored in a local first.
        for local in re.findall(r"(?:const|let|var)\s+(\w+)\s*=\s*%s\(\)" % re.escape(name),
                                text):
            bindings[local] = section
    # `getConfiguration(pipeline.CONFIG)` and the module-local `config()` helper.
    for name in re.findall(
            r"(?:const|let|var)\s+(\w+)\s*=\s*(?:vscode\.workspace\.)?"
            r"getConfiguration\(\s*[\w.]*CONFIG\s*\)", text):
        bindings[name] = PIPELINE_SECTION
    for name in re.findall(r"(?:const|let|var)\s+(\w+)\s*=\s*config\(\)", text):
        bindings.setdefault(name, PIPELINE_SECTION)

    for section, key in re.findall(
            r"getConfiguration\(\s*['\"]([\w.]+)['\"]\s*\)\s*\.\s*get\(\s*['\"]([\w.]+)['\"]",
            text):
        found.add("%s.%s" % (section, key))
    for key in re.findall(r"\bconfig\(\)\s*\.\s*get\(\s*['\"]([\w.]+)['\"]", text):
        found.add("%s.%s" % (PIPELINE_SECTION, key))
    # getConfiguration(pipeline.CONFIG).get('key') - chained through the constant rather than
    # a literal section name.
    for key in re.findall(
            r"getConfiguration\(\s*[\w.]*CONFIG\s*\)\s*\.\s*get\(\s*['\"]([\w.]+)['\"]", text):
        found.add("%s.%s" % (PIPELINE_SECTION, key))
    for name, key in re.findall(r"\b(\w+)\s*\.\s*get\(\s*['\"]([\w.]+)['\"]", text):
        if name in bindings:
            found.add("%s.%s" % (bindings[name], key))
    return found


used_settings = set()
for js in JS_SOURCES:
    used_settings |= settings_read(open(rel(*js.split("/")), encoding="utf-8").read())
unknown = used_settings - declared_settings
if unknown:
    bad("the code reads settings the manifest does not declare", " ".join(sorted(unknown)))
else:
    ok("every setting the code reads is declared (%d)" % len(used_settings))

unread = declared_settings - used_settings
if unread:
    warn("declared settings nothing reads", " ".join(sorted(unread)))
else:
    ok("every declared setting is read somewhere")

# A when-clause naming a context key nothing ever sets is silently always false, so the menu
# entry or welcome block it guards simply never appears.
set_keys = set()
for js in JS_SOURCES:
    text = open(rel(*js.split("/")), encoding="utf-8").read()
    set_keys.update(re.findall(r"setContext['\"]?\s*,\s*['\"`]nvIsaExtractor\.([\w.]+)", text))
    set_keys.update(re.findall(r"setContext\(\s*['\"]([\w.]+)['\"]", text))
    set_keys.update(re.findall(r"nvIsaExtractor\.\$\{?([\w.]+)", text))
    # the template form: setContext(`nvIsaExtractor.${key}`) with the keys passed in
    for call in re.findall(r"setContext\(\s*['\"]([\w.]+)['\"]\s*,", text):
        set_keys.add(call)
# Every own context key the manifest tests, found rather than listed - a hand-kept whitelist
# quietly stops covering a key the moment one is renamed or mistyped.
used_keys = set()
for clause in re.findall(r'"(?:when|enablement)"\s*:\s*"((?:[^"\\]|\\.)*)"', manifest_text):
    for name in re.findall(r"nvIsaExtractor\.([A-Za-z][\w.]*)", clause):
        # `view == nvIsaExtractor.objects` names a view, not a context key, and views are
        # checked separately above.
        if "nvIsaExtractor.%s" % name not in declared_views:
            used_keys.add(name)
missing_keys = used_keys - set_keys
if missing_keys:
    bad("a when-clause names a context key nothing sets", " ".join(sorted(missing_keys)))
else:
    ok("every context key used in a when-clause is set by the code (%d)" % len(used_keys))

# The dev machine runs a much newer VS Code than the declared floor, so nothing else in this
# toolchain would notice an API that does not exist on 1.75 creeping in.
TOO_NEW = {
    "checkboxState": "TreeItem.checkboxState (1.80)",
    "TreeItemCheckboxState": "TreeItemCheckboxState (1.80)",
    "onDidChangeCheckboxState": "TreeView.onDidChangeCheckboxState (1.80)",
    "manageCheckboxStateManually": "TreeViewOptions.manageCheckboxStateManually (1.80)",
    "secondarySidebar": "viewsContainers.secondarySidebar (much later)",
}
trespass = []
for js in tuple(JS_SOURCES) + ("package.json",):
    text = open(rel(*js.split("/")), encoding="utf-8").read()
    for needle, what in TOO_NEW.items():
        if needle in text:
            trespass.append("%s uses %s" % (js, what))
floor = manifest["engines"]["vscode"]
if trespass:
    bad("an API newer than the declared engine floor (%s) is in use" % floor,
        "\n".join(trespass))
else:
    ok("no API newer than the declared engine floor (%s) is in use" % floor)

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

# One entry per language, each checked. This used to read `semanticTokenScopes[0]`, which is
# the only entry today - but these scopes are what give every semantic token a colour in themes
# that do not opt into semantic highlighting, so a second language whose entry went unchecked
# would lose its fallbacks silently, in exactly the themes least able to survive it.
# The modifier combinations the semantic provider emits, which every language it serves has to
# give a TextMate fallback for. Defined before the loop because it is checked INSIDE it: these
# scopes are what colour a token in a theme that never opts into semantic highlighting, so a
# language missing them loses its colours in exactly the themes least able to survive it.
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

semantic_scope_entries = contributes["semanticTokenScopes"]
scope_types = set()
# A SET of scopes, not a merged selector->scopes dict. `scope_map.update(entry_map)` let a
# later entry overwrite an earlier one's mapping for the same selector, and `fallback_scopes`
# was derived from the survivor - so the stock-Dark+ orphan check below, the one HANDOFF.md
# credits with catching the `constant.other` bug, silently stopped examining the scopes that
# were overwritten. Every scope every language declares has to be checked, so every scope is
# collected.
fallback_scope_set = set()
for entry in semantic_scope_entries:
    entry_map = entry["scopes"]
    where = entry.get("language", "(no language)")
    entry_types = {selector.split(".")[0] for selector in entry_map}
    scope_types |= entry_types
    for scopes in entry_map.values():
        fallback_scope_set.update([scopes] if isinstance(scopes, str) else scopes)

    undeclared = entry_types - declared_types
    if undeclared:
        bad("semanticTokenScopes[%s] names an undeclared type" % where,
            " ".join(sorted(undeclared)))
    else:
        ok("semanticTokenScopes[%s] only names declared types" % where)

    unmapped = declared_types - entry_types
    if unmapped:
        warn("declared semantic types with no TextMate fallback scope in %s" % where,
             " ".join(sorted(unmapped)))
    else:
        ok("every semantic type has a TextMate fallback scope in %s" % where)

    # Per entry, not against the union. Checked against a merged map, a second language
    # declaring NONE of these passed because the first language's entries were still in the
    # dict - which is the precise failure the per-language loop was introduced to prevent.
    missing_fallbacks = required_fallbacks - set(entry_map)
    if missing_fallbacks:
        bad("semanticTokenScopes[%s] lacks TextMate fallbacks for emitted modifier "
            "combinations" % where, " ".join(sorted(missing_fallbacks)))
    else:
        ok("every emitted semantic modifier combination has a TextMate fallback in %s" % where)

fallback_scopes = sorted(fallback_scope_set)

# ------------------------------------------------------------- 5. theme cover

print("\n5. Theme coverage")

# Every declared grammar, not the one file this used to name. The themes have to cover the
# scopes of all of them - and the stock-Dark+ fall-through check below, which HANDOFF.md records
# as having caught a real bug, is only worth having if it sees a second grammar when there is
# one.
grammar_scopes = set()
for entry in contributes["grammars"]:
    grammar_path = rel(*entry["path"].lstrip("./").split("/"))
    for node_scopes in re.findall(r'"(?:name|contentName)"\s*:\s*"([^"]+)"',
                                  open(grammar_path, encoding="utf-8").read()):
        if "." in node_scopes:                    # skip the grammar's own display name
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


# Most people never switch to the bundled themes, so styling every scope in *those* proves
# very little on its own. A scope is only coloured by a theme that has a rule matching one of
# its dotted prefixes, so a scope rooted somewhere the common themes do not style renders as
# plain foreground everywhere but here.
#
# This caught a real one: all five control-column fields were rooted at `constant.other`,
# which the default theme family does not style - dark_vs defines constant.language,
# constant.numeric, constant.regexp and constant.character and nothing bare enough to catch
# it - so the column, which is the reason this extension exists, was colourless in Dark+,
# Dark Modern, Light+ and both high-contrast themes.
#
# Punctuation is exempt: every theme leaves it at the foreground colour deliberately.
def stock_dark_plus():
    """VS Code's own Dark+ theme, with its include chain resolved, or None."""
    roots = []
    for exe in (os.environ.get("VSCODE_EXE"),
                r"D:\Development\Programs\Microsoft VS Code\Code.exe",
                os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"),
                r"C:\Program Files\Microsoft VS Code\Code.exe"):
        if exe and os.path.exists(exe):
            roots.append(os.path.dirname(exe))
    found = []
    for root in roots:
        for depth in ("resources/app/extensions", "*/resources/app/extensions"):
            found.extend(glob.glob(os.path.join(
                root, depth, "theme-defaults", "themes", "dark_plus.json")))
    if not found:
        return None

    def load(path, seen):
        if path in seen or not os.path.exists(path):
            return []
        seen.add(path)
        with open(path, encoding="utf-8-sig") as handle:
            data = json.load(handle)
        base = load(os.path.join(os.path.dirname(path), data["include"]), seen) \
            if data.get("include") else []
        return base + (data.get("tokenColors") or [])

    return load(found[0], set())


stock_rules = stock_dark_plus()
if stock_rules is None:
    skip("VS Code's own themes were not found, so stock-theme coverage was not checked")
else:
    rules = set()
    for rule in stock_rules:
        if not (rule.get("settings") or {}).get("foreground"):
            continue
        scope = rule.get("scope") or []
        for entry in ([scope] if isinstance(scope, str) else scope):
            for part in str(entry).split(","):
                part = part.strip().split()[-1] if part.strip().split() else ""
                if part:
                    rules.add(part)

    # The semantic fallbacks are checked alongside the grammar's own scopes. They are what a
    # foreign theme actually colours the semantic pass with, and they drift independently of
    # the grammar - `sassLabel` went on naming `entity.name.label.sass` after the grammar had
    # moved to `entity.name.function.label.sass`, and nothing compared the two.
    checked = set(grammar_scopes) | set(fallback_scopes)
    exempt = {s for s in checked if s.startswith("punctuation.")}
    orphans = sorted(s for s in checked if s not in exempt and not covered_by(s, rules))
    if orphans:
        bad("scopes that VS Code's own Dark+ theme would leave at plain foreground",
            "\n".join(orphans) +
            "\n(root each at a prefix stock themes style: keyword.*, storage.modifier.*, "
            "constant.numeric/language.*, variable.other/language.*, entity.name.function.*, "
            "string.*, comment.*)")
    else:
        ok("every non-punctuation grammar scope and semantic fallback is coloured by "
           "VS Code's stock Dark+ (%d checked)" % len(checked - exempt))

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
        # `None`, not `{}`. An empty dict is not "no changes", it is an empty environment -
        # and a Windows process started without SystemRoot or PATH aborts during startup,
        # before it runs a line of the script. Every suite then failed with exit 134 and a V8
        # stack trace, on precisely the machines that had a real Node to run them with. The
        # Electron branch below copies os.environ for the same reason; this one inherits it.
        return [node], None
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
         "Set VSCODE_EXE to a Code.exe, or install Node, to run the JavaScript suites.\n"
         "This also means NOTHING here has checked that the shipped modules parse. A module "
         "that does not parse takes the whole extension down at activation, and every check "
         "above it passes because they all read the source as text.")
else:
    # Does every shipped module parse?
    #
    # This is first because it is the cheapest check in the file and the most catastrophic
    # failure it can find: a module that does not parse takes the entire extension down at
    # activation - every command, every view, every provider - not just the feature it belongs
    # to. Everything above this point reads JavaScript as TEXT (scraping requires, settings
    # names, token types), so all of it passes happily on a file the engine would refuse.
    #
    # It exists because that happened. `const { target } = ...` was added to a function whose
    # parameter was already named `target`, which is an early error rather than a shadow, and
    # ten commits went by: `test_endtoend.js` caught it immediately, but this file reports one
    # result per SCRIPT, so a suite dying at its third check and a suite dying at its fortieth
    # look identical in the summary. Naming the unparseable file directly is the difference
    # between a five-second fix and a bisect.
    unparseable = []
    for src_name in walked + ["extension.js"]:
        src_path = rel("src", *src_name.split("/")) if src_name != "extension.js" \
            else rel("extension.js")
        proc = subprocess.run(cmd + ["--check", src_path],
                              env=env, cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            first = (proc.stderr or proc.stdout or "").strip().split("\n")
            detail = next((line.strip() for line in first if "Error" in line), first[0] if first else "")
            unparseable.append("%s: %s" % (src_name, detail))
    if unparseable:
        bad("some shipped modules do not parse", "\n".join(unparseable))
    else:
        ok("every shipped module parses (%d files)" % (len(walked) + 1))

    # Roughly unit first, then integration. `test_golden.js` sits at the boundary: it pins the
    # whole listing - banner and body - but builds its own instruction stream, so it needs no
    # CUDA, no driver and no GPU and belongs with the suites that always run rather than with
    # the ones that skip.
    for script in ("test_parse.js", "test_rdna_parse.js", "test_rdna_depend.js",
                   "test_hover.js", "test_semantic.js", "test_explain.js",
                   "test_ctrl.js", "test_zstd.js", "test_scoreboard.js", "test_stats.js",
                   "test_golden.js",
                   "test_blobstore.js", "test_compile.js", "test_rga.js", "test_gfx.js",
                   "test_browser.js", "test_endtoend.js"):
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

# "PASS" on a run that never executed a line of JavaScript is a true statement about what ran
# and a false impression of what was checked. On a machine with no runtime this file verifies
# manifests, JSON shape and regexes - none of which can tell whether the extension loads - and
# it printed the same word as a full run. It now says which, because the difference between
# "this is good" and "this is as good as I could tell from here" is the whole value of a gate.
verdict = "FAIL" if failures else ("PASS" if cmd else "PARTIAL")
print("%s   %d passed, %d failed, %d warnings%s"
      % (verdict, passes, len(failures), len(warnings),
         ", %d skipped" % len(skipped) if skipped else ""))
if failures:
    for f in failures:
        print("  - %s" % f)
if not cmd:
    print("  no JavaScript ran: the suites and the parse check were both skipped.")
sys.exit(1 if failures else 0)
