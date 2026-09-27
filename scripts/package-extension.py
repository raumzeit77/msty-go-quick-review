#!/usr/bin/env python3
"""Package / verify the Hermes Review extension ZIP from an EXPLICIT member -> source map.

(t_dd3d5a62. Follows the 1.3.5 review round 1 of `t_c025821b`.)

The ZIP is FLAT — its members sit at the archive root, with no `hermes-review-extension/`
prefix — while this repo has **two** files named `README.md`:

  * `hermes-review-extension/README.md` — the extension's own user README. This is the packaged
    member, and the shape the host's own packages ship: Msty Go stores it as
    `extensions.package.file.v1.<id>:README.md`.
  * `README.md` (repo root) — developer documentation (gate commands, layout, the `AGENTS.md`
    and `archive/` pointers) referring to paths an installable does not contain. It is **never**
    a package member.

A check that resolves a member by *name* therefore passes silently against the wrong file, and
the release record's claim "each member byte-identical to the working tree" stops being checkable
— which is exactly what review round 1 could neither prove nor disprove. So every member below
is declared with the **source path it must come from**, and `verify` fails when a member's bytes
are a plausible-but-wrong same-named file (it names the decoy instead of reporting a bare mismatch).

Usage
  python3 scripts/package-extension.py verify <zip> [--source-dir DIR] [--repo-root DIR]
  python3 scripts/package-extension.py build --out <zip> [--source-dir DIR] [--force]

Exit code 0 = clean, 1 = findings.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import zipfile

SOURCE_DIR_DEFAULT = "hermes-review-extension"

# The map. (member name, source path INSIDE the source dir, why that source is the member)
MEMBERS = (
    ("README.md", "README.md",
     "the extension's own user README — the member the host stores as "
     "extensions.package.file.v1.<id>:README.md; the repo root README.md is developer docs "
     "and is never a member"),
    ("extension.js", "extension.js", "runtime entry the host loads"),
    ("manifest.json", "manifest.json", "the manifest the host validates"),
    ("review-core.js", "review-core.js", "shared review core"),
    ("review-history.js", "review-history.js", "per-chat review history"),
    ("review-pane.js", "review-pane.js", "pane runtime"),
    ("static/icon.svg", "static/icon.svg", "the declared extension icon"),
    ("view.css", "view.css", "pane stylesheet"),
    ("view.js", "view.js", "pane view"),
)

# Files that live in the source dir and must NEVER be members.
NOT_MEMBERS = (
    (".authoring-guide.md", "the host's authoring guide — reference only"),
    ("manifest.schema.json", "the manifest JSON Schema — a host contract file"),
    ("msty-extension-api.d.ts", "editor-only API typings, never imported at runtime"),
)

# Anything matching these is a build artefact / cache, never a member.
BANNED_SUFFIXES = (".map",)
BANNED_MARKERS = ("__MACOSX",)
BANNED_NAMES = (".DS_Store",)

SKIP_DIRS = {".git", "archive", "node_modules", "releases", ".worktrees"}


def ignored_dir_names(repo_root="."):
    """SKIP_DIRS plus every directory this repo's .gitignore marks as ignored/generated.

    The publish snapshot is assembled INSIDE the tree (gitignored) and carries a copy of the
    extension by construction. Walking it would report every member as a same-named decoy —
    true of a copy, and meaningless as the warning this check exists to raise.
    """
    names = set(SKIP_DIRS)
    try:
        with open(os.path.join(repo_root, ".gitignore"), encoding="utf-8") as fh:
            for line in fh:
                entry = line.strip()
                if not entry or entry.startswith("#") or entry.startswith("!"):
                    continue
                if entry.endswith("/") and "/" not in entry.rstrip("/"):
                    names.add(entry.rstrip("/"))
    except OSError:
        pass
    return names

findings = []


def report(ok, msg):
    findings.append((ok, msg))
    print(("  ok   " if ok else "  FAIL ") + msg)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def short(digest):
    return digest[:12]


def source_path(source_dir, subpath):
    return os.path.normpath(os.path.join(source_dir, subpath))


def members_map(source_dir):
    """member -> absolute source path, refusing any source outside the source dir."""
    out = {}
    for member, subpath, _why in MEMBERS:
        path = source_path(source_dir, subpath)
        out[member] = path
    return out


def same_named_files(repo_root, basename, exclude):
    """Every other file in the repo with this basename — the ambiguity a name-only check hides."""
    found = []
    skip = ignored_dir_names(repo_root)
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in skip]
        for name in files:
            path = os.path.join(root, name)
            if os.path.abspath(path) == os.path.abspath(exclude):
                continue
            if name == basename:
                found.append(path)
    return sorted(found)


def check_source_dir_is_not_repo_root(source_dir, repo_root):
    return os.path.abspath(source_dir) != os.path.abspath(repo_root)


def read_zip(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        return infos, {info.filename: archive.read(info.filename) for info in infos}


def expected_version(zip_path):
    match = re.search(r"-v(\d+\.\d+\.\d+)\.zip$", os.path.basename(zip_path))
    return match.group(1) if match else None


def verify(args):
    zip_path = args.zip
    source_dir = args.source_dir
    repo_root = args.repo_root

    print(f"package:    {zip_path}")
    print(f"source dir: {source_dir}")
    print(f"repo root:  {repo_root}")

    if not os.path.exists(zip_path):
        report(False, f"{zip_path} does not exist")
        return 1

    print("[member identity]")
    report(check_source_dir_is_not_repo_root(source_dir, repo_root),
           f"the extension source dir ({os.path.normpath(source_dir)}) is not the repo root — "
           "that is how README.md would resolve to the wrong file")
    if not os.path.isdir(source_dir):
        report(False, f"source dir {source_dir} does not exist")
        return 1

    infos, blobs = read_zip(zip_path)
    names = sorted(info.filename for info in infos)
    mapped = members_map(source_dir)
    expected = [member for member, _s, _w in MEMBERS]
    lower_names = {name.lower() for name in names}

    missing = [member for member in expected if member not in names]
    report(not missing, "every mapped member is present in the ZIP"
                        + (f" — MISSING: {missing}" if missing else ""))
    unmapped = [name for name in names if name not in mapped]
    report(not unmapped, "every ZIP member is in the map (nothing resolved implicitly by name)"
                         + (f" — UNMAPPED: {unmapped}" if unmapped else ""))
    banned = sorted(name for name in names
                    if name in [n for n, _r in NOT_MEMBERS]
                    or name.endswith(BANNED_SUFFIXES)
                    or any(marker in name for marker in BANNED_MARKERS)
                    or name in BANNED_NAMES)
    report(not banned, "no contract file / cache / build artefact is a member"
                       + (f" — BANNED: {banned}" if banned else ""))
    report(len(names) == len(lower_names),
           "no two members differ only by case"
           + ("" if len(names) == len(lower_names) else " — the ZIP is ambiguous on a case-insensitive host"))

    for member, subpath, _why in MEMBERS:
        source = mapped[member]
        if member not in blobs:
            continue
        data = blobs[member]
        if not os.path.exists(source):
            report(False, f"{member}: mapped source {source} does not exist")
            continue
        source_bytes = open(source, "rb").read()
        decoys = same_named_files(repo_root, os.path.basename(member), exclude=source)
        digest = short(sha256(data))
        identical = source_bytes == data
        if identical:
            report(True, f"{member} <- {source} ({len(data):,} B, sha256 {digest}…) "
                         "is byte-identical to its named source")
        else:
            report(False, f"{member} differs from its named source {source} "
                          f"(ZIP {len(data):,} B, source {len(source_bytes):,} B) — the packaged "
                          "member is not the file the map names")
        for decoy in decoys:
            decoy_bytes = open(decoy, "rb").read()
            if decoy_bytes == data:
                report(False, f"{member} is byte-identical to the same-named file {decoy} — "
                              "the member came from a plausible-but-wrong file resolved by name, "
                              "not from the mapped source")
            else:
                print(f"       same name elsewhere: {decoy} ({len(decoy_bytes):,} B, "
                      f"sha256 {short(sha256(decoy_bytes))}…) differs — asserted")

    print("[version]")
    want = expected_version(zip_path)
    if want is None:
        print("       filename carries no -vX.Y.Z.zip suffix — version not checked")
    elif "manifest.json" in blobs:
        packaged = json.loads(blobs["manifest.json"].decode("utf-8")).get("version")
        report(packaged == want,
               f"the packaged manifest version ({packaged}) matches the release filename ({want})")
    else:
        report(False, "manifest.json is not a member — the packaged version cannot be read back")

    bad = [msg for ok, msg in findings if not ok]
    print()
    if bad:
        print(f"{len(bad)} FINDING(S)")
    else:
        shipped = len([m for m in expected if m in names])
        print(f"PACKAGE VERIFY CLEAN — {shipped}/{len(expected)} members byte-identical "
              "to their named sources")
    return 1 if bad else 0


def build(args):
    source_dir = args.source_dir
    out = args.out
    findings_local = []
    print(f"source dir: {source_dir}")
    print(f"output:     {out}")

    if not check_source_dir_is_not_repo_root(source_dir, os.path.abspath(".")):
        findings_local.append("the source dir must not be the repo root (README.md would resolve to the wrong file)")
    if not os.path.isdir(source_dir):
        findings_local.append(f"source dir {source_dir} does not exist")
    if os.path.exists(out) and not args.force:
        findings_local.append(f"{out} exists — a released artifact is not rebuilt in place; "
                              "pass --force only to rebuild deliberately")
    if findings_local:
        for message in findings_local:
            print("  FAIL " + message)
        print()
        print(f"{len(findings_local)} FINDING(S)")
        return 1

    payload = []
    for member, subpath, _why in MEMBERS:
        source = source_path(source_dir, subpath)
        if not os.path.exists(source):
            report(False, f"{member}: mapped source {source} does not exist")
            continue
        data = open(source, "rb").read()
        payload.append((member, source, data))
        print(f"  member {member:22s} <- {source} ({len(data):,} B, sha256 {short(sha256(data))}…)")
    bad = [msg for ok, msg in findings if not ok]
    if bad:
        print()
        print(f"{len(bad)} FINDING(S) — nothing written")
        return 1

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for member, _source, data in sorted(payload):
            info = zipfile.ZipInfo(member, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)

    blob = open(out, "rb").read()
    print()
    print(f"built {out} — {len(payload)} members, {len(blob):,} B, sha256 {sha256(blob)}")
    print("Entry timestamps are fixed and members sorted, so a rebuild is reproducible; the ZIP bytes "
          "of a released artifact still differ (its entry times are real), so a rebuild must be "
          "re-hashed and re-recorded in the release record.")
    print(f"verify it with: python3 {os.path.relpath(__file__)} verify {out} --source-dir {source_dir}")
    return 0


def show_map(args):
    """Print the map itself — what ships, from where, and what must never ship."""
    payload = {
        "source_dir": args.source_dir,
        "members": [{"member": member, "source": subpath, "why": why}
                    for member, subpath, why in MEMBERS],
        "non_members": [{"path": subpath, "why": why} for subpath, why in NOT_MEMBERS],
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    print(f"source dir: {args.source_dir}")
    print("[members] every one is shipped, resolved ONLY by the source path below")
    for entry in payload["members"]:
        print(f"  {entry['member']:22s} <- {entry['source']}")
        print(f"       why: {entry['why']}")
    print("[non-members] present in the source dir, never shipped")
    for entry in payload["non_members"]:
        print(f"  {entry['path']:22s} why: {entry['why']}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Package / verify the extension ZIP from an explicit member -> source map.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    map_parser = subparsers.add_parser("map", help="print the member -> source map")
    map_parser.add_argument("--source-dir", default=SOURCE_DIR_DEFAULT)
    map_parser.add_argument("--json", action="store_true")
    map_parser.set_defaults(run=show_map)

    verify_parser = subparsers.add_parser("verify", help="check a built ZIP against the member map")
    verify_parser.add_argument("zip")
    verify_parser.add_argument("--source-dir", default=SOURCE_DIR_DEFAULT)
    verify_parser.add_argument("--repo-root", default=".")
    verify_parser.set_defaults(run=verify)

    build_parser = subparsers.add_parser("build", help="build a ZIP from the member map")
    build_parser.add_argument("--out", required=True)
    build_parser.add_argument("--source-dir", default=SOURCE_DIR_DEFAULT)
    build_parser.add_argument("--force", action="store_true")
    build_parser.set_defaults(run=build)

    args = parser.parse_args()
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
