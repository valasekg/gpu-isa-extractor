#!/usr/bin/env python3
"""Build an installable .vsix without vsce.

    py tools/package_vsix.py                # build
    py tools/package_vsix.py --install      # build, then install it into VS Code

A .vsix is an OPC zip: `extension.vsixmanifest`, `[Content_Types].xml`, and the extension
itself under `extension/`. vsce is the usual way to produce one, but it needs npm, which
is not available here - and this extension has no build step to run anyway.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

# What ships. Test corpora and the tooling stay out - they are for developing the
# extension, not for running it.
INCLUDE_FILES = [
    "package.json", "language-configuration.json", "extension.js", "README.md", "LICENSE",
    "THIRD_PARTY_NOTICES.md"
]
INCLUDE_DIRS = ["src", "syntaxes", "themes", "data"]
SKIP_SUFFIXES = (".pyc",)
SKIP_DIRS = {"__pycache__"}

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <!-- src/nvrtc_compile.py: NVRTC is a DLL with no command-line front end, and the extension
       host cannot call one, so the CUDA front end is reached through a Python helper. -->
  <Default Extension="py" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
"""

MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0"
    xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"
    xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Tags>{tags}</Tags>
    <Categories>{categories}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def collect():
    """(archive path, source path) for everything that ships."""
    out = []
    for name in INCLUDE_FILES:
        path = os.path.join(ROOT, name)
        if os.path.exists(path):
            out.append(("extension/" + name, path))
        else:
            print("  note: %s not found, skipping" % name)
    for directory in INCLUDE_DIRS:
        base = os.path.join(ROOT, directory)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for filename in sorted(filenames):
                if filename.endswith(SKIP_SUFFIXES):
                    continue
                full = os.path.join(dirpath, filename)
                arc = "extension/" + os.path.relpath(full, ROOT).replace(os.sep, "/")
                out.append((arc, full))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--install", action="store_true",
                    help="install the built .vsix into VS Code via the `code` CLI")
    ap.add_argument("-o", "--output", help="output path (default <name>-<version>.vsix)")
    args = ap.parse_args()

    pkg = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
    name, version = pkg["name"], pkg["version"]
    out = args.output or os.path.join(ROOT, "%s-%s.vsix" % (name, version))

    manifest = MANIFEST.format(
        name=escape(name), version=escape(version), publisher=escape(pkg["publisher"]),
        display_name=escape(pkg["displayName"]), description=escape(pkg["description"]),
        tags=escape(",".join(pkg.get("keywords", []))),
        categories=escape(",".join(pkg.get("categories", []))),
        engine=escape(pkg["engines"]["vscode"]))

    files = collect()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("extension.vsixmanifest", manifest)
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        for arc, path in files:
            z.write(path, arc)

    size = os.path.getsize(out)
    print("wrote %s  (%d files, %.1f KB)" % (os.path.relpath(out, ROOT), len(files) + 2,
                                             size / 1024.0))

    if args.install:
        code = shutil.which("code") or shutil.which("code.cmd")
        if not code:
            print("`code` CLI not found on PATH; install manually with:\n"
                  "  code --install-extension %s" % out)
            return 1
        proc = subprocess.run([code, "--install-extension", out, "--force"],
                              capture_output=True, text=True)
        print((proc.stdout or "") + (proc.stderr or ""), end="")
        if proc.returncode != 0:
            print("install failed (exit %d)" % proc.returncode)
            return proc.returncode
        print("installed; reload VS Code to pick it up")
    return 0


if __name__ == "__main__":
    sys.exit(main())
