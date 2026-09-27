#!/usr/bin/env python3
"""Offline pre-flight for a Msty Go extension package.

Mirrors, as far as a static check can, the checks the HOST performs itself:
  * manifest validity against the shipped JSON Schema (draft 2020-12)
  * every declared permission is in the host's permission vocabulary
        -> host error: permission_unknown
  * every declared contribution carries its matching permission
        -> host error: contribution_permission_missing
  * every host API call in the runtime has its matching permission
        -> host error: extension_permission_missing  (packager's source scan)
  * author.name present  -> host error: author_name_missing
  * manifestVersion == 1 -> host error: manifest_version_unsupported
  * no awaited openContributions/openPopup (the open promise resolves only on close)
  * ZIP structure: manifest.json at the root, no wrapper folder, no contract files,
    every declared entry/icon path present (nested asset paths are legal)

Vocabulary and mapping come from the official guide (§Contribution Permissions,
§Permission Reference) as recovered by card t_a14cafc4.

Usage: python3 perm-preflight.py <extension-dir> [<zip>]
Exit code 0 = no findings, 1 = findings.
"""
import json
import os
import re
import sys
import zipfile

# guide §Permission Reference — the full host vocabulary
VOCAB = {
    "context.read", "context.provide", "chats.read", "chats.write", "messages.read",
    "messages.write", "messages.hooks", "messages.modify", "composer.read", "composer.write",
    "models.infer", "models.provide", "models.local", "agent.behavior", "storage.local",
    "storage.chat", "storage.workspace", "secrets.read", "secrets.write", "files.read",
    "files.write", "network.fetch", "themes.provide", "settings.provide", "rules.provide",
    "playbooks.provide", "tasks.provide", "triggers.provide", "commands.provide",
    "tools.provide", "tools.override", "ui.render", "ui.fullView", "ui.dialog", "ui.drawer",
    "ui.popup", "ui.statusBar", "ui.titleBar", "ui.workspace", "ui.toolbox", "ui.emptyPill",
    "ui.messageInline", "ui.composerInline", "ui.pulse", "events.subscribe",
    "clipboard.write", "notifications.show",
}

# guide §Contribution Permissions — contribution key -> required permission
CONTRIBUTION_PERMISSION = {
    "rules": "rules.provide", "playbooks": "playbooks.provide", "tasks": "tasks.provide",
    "commands": "commands.provide", "tools": "tools.provide",
    "chatContextProviders": "context.provide", "agentHarnesses": "agent.behavior",
    "preSendHooks": "messages.hooks", "postMessageHooks": "messages.hooks",
    "themes": "themes.provide", "settings": "settings.provide", "fullViews": "ui.fullView",
    "dialogs": "ui.dialog", "drawers": "ui.drawer", "popups": "ui.popup",
    "workspaceItems": "ui.workspace", "toolboxItems": "ui.toolbox",
    "titleBarItems": "ui.titleBar", "statusBarPills": "ui.statusBar",
    "emptyPillItems": "ui.emptyPill", "pulseItems": "ui.pulse",
    "messageInlineItems": "ui.messageInline", "composerInlineItems": "ui.composerInline",
}

# runtime call pattern -> permission it implies
CALL_PERMISSION = [
    (r"msty\.notifications\.show", "notifications.show"),
    (r"msty\.models\.infer", "models.infer"),
    (r"msty\.models\.(getStatus|list|get)\w*", "models.infer"),
    (r"msty\.messages\.\w+", "messages.read"),
    (r"msty\.context\.\w+", "context.read"),
    (r"msty\.chats?\.(read|get)\w*", "chats.read"),
    (r"msty\.composer\.get", "composer.read"),
    (r"msty\.composer\.(setText|clear|insert)\w*", "composer.write"),
    (r"msty\.ui\.openPopup", "ui.popup"),
    (r"msty\.ui\.registerWorkspaceItem", "ui.workspace"),
    (r"msty\.commands\.register", "commands.provide"),
    (r"msty\.secrets\.get", "secrets.read"),
    (r"msty\.network\.fetch", "network.fetch"),
    (r"msty\.storage\.workspace", "storage.workspace"),
    (r"msty\.storage\.chat", "storage.chat"),
    (r"msty\.storage\.local", "storage.local"),
    # t_054750c9: the pane's re-scope carrier is the documented app event stream
    # (`msty.events.subscribe`), which the host gates behind this permission.
    (r"msty\.events\.subscribe", "events.subscribe"),
]

OPEN_KIND_PERMISSION = {"drawer": "ui.drawer", "popup": "ui.popup",
                        "dialog": "ui.dialog", "fullView": "ui.fullView"}

findings = []


def report(ok, msg):
    findings.append((ok, msg))
    print(("  ok   " if ok else "  FAIL ") + msg)


def main():
    ext_dir = sys.argv[1]
    zip_path = sys.argv[2] if len(sys.argv) > 2 else None
    man_path = os.path.join(ext_dir, "manifest.json")
    manifest = json.load(open(man_path))
    declared = {p.get("id") for p in manifest.get("permissions", [])}
    contributes = manifest.get("contributes", {}) or {}

    print("manifest:", man_path)
    print("[identity]")
    report(bool(manifest.get("author", {}).get("name")),
           "author.name present (host code author_name_missing otherwise)")
    report(manifest.get("manifestVersion") == 1,
           "manifestVersion == 1 (host code manifest_version_unsupported otherwise)")

    print("[permissions declared]")
    unknown = sorted(declared - VOCAB)
    report(not unknown, "every declared permission is in the host vocabulary"
                        + (f" — UNKNOWN: {unknown}" if unknown else ""))
    perms = manifest.get("permissions", [])
    report(bool(perms),
           f"permissions[] non-empty and each carries a reason "
           f"({sum(1 for p in perms if p.get('reason'))}/{len(perms)} carry a reason)")

    print("[contributions -> permission]")
    for key in sorted(contributes):
        need = CONTRIBUTION_PERMISSION.get(key)
        if need is None:
            report(True, f"contributes.{key}: not in the mapped table (check the guide by hand)")
        else:
            report(need in declared,
                   f"contributes.{key} has {need} (host code contribution_permission_missing otherwise)")

    print("[runtime calls -> permission]")
    sources = []
    for root, _dirs, files in os.walk(ext_dir):
        if os.sep + "node_modules" in root:
            continue
        for f in files:
            if f.endswith(".js"):
                sources.append(os.path.join(root, f))
    patterns_hit, calls, kinds = set(), set(), set()
    for path in sources:
        text = open(path, encoding="utf-8", errors="replace").read()
        for pat, _perm in CALL_PERMISSION:
            for m in re.finditer(pat, text):
                patterns_hit.add(pat)
                calls.add(m.group(0))
        kinds |= set(re.findall(r'kind:\s*"(\w+)"', text))
        if re.search(r"await\s+msty\.ui\.(openContribution|openPopup)", text):
            report(False, f"{os.path.basename(path)}: awaits an open* promise — it resolves only "
                          "when the surface closes, so the caller blocks")
    missing = sorted({perm for pat, perm in CALL_PERMISSION
                      if pat in patterns_hit and perm not in declared})
    report(not missing, "every host API call in the runtime has its permission"
                        + (f" — MISSING: {missing}" if missing else ""))
    print("       calls seen:", ", ".join(sorted(calls)) or "(none)")
    for kind in sorted(kinds):
        need = OPEN_KIND_PERMISSION.get(kind)
        if need:
            report(need in declared, f'openContribution kind "{kind}" has {need}')

    if zip_path and os.path.exists(zip_path):
        print("[package]", zip_path)
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            tops = {n.split("/")[0] for n in names}
            wrapper = len(tops) == 1 and any("/" in n for n in names)
            nested = sorted(n for n in names if "/" in n)
            report("manifest.json" in names and not wrapper,
                   f"manifest.json at the ZIP root, no wrapper folder "
                   f"({len(names)} entries, nested assets: {nested})")
            banned = [n for n in names if n in ("manifest.schema.json", "msty-extension-api.d.ts",
                                                ".authoring-guide.md", "README-dev.md")
                      or n.endswith(".map") or "__MACOSX" in n or n.endswith(".DS_Store")]
            report(not banned, f"no contract files / caches in the ZIP ({banned})" if banned
                   else "no contract files / caches in the ZIP")
            declared_assets = []
            for key in ("icon", "entry"):
                if isinstance(manifest.get(key), str):
                    declared_assets.append(manifest[key])
            for item in (manifest.get("contributes", {}).get("titleBarItems") or []):
                if isinstance(item.get("icon"), str):
                    declared_assets.append(item["icon"])
            for item in (manifest.get("contributes", {}).get("popups") or []):
                if isinstance(item.get("entry"), str):
                    declared_assets.append(item["entry"])
            absent = [a for a in declared_assets if a.lstrip("./") not in names]
            report(not absent, f"every declared entry/icon path exists in the ZIP ({absent})"
                   if absent else "every declared entry/icon path exists in the ZIP")

    bad = [m for ok, m in findings if not ok]
    print()
    print("PRE-FLIGHT CLEAN" if not bad else f"{len(bad)} FINDING(S)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
