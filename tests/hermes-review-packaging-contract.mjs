// t_dd3d5a62 — packaging contract. The release record claims "each member byte-identical to
// the working tree"; this suite makes that claim machine-checkable, because a flat ZIP whose
// members sit at the archive root collides with a repo that has TWO files named `README.md`:
// `hermes-review-extension/README.md` (the extension's own user README — the packaged member,
// the shape the host's own packages ship) and the repo root `README.md` (developer docs, never
// a member). A check that resolves a member by name can pass against the wrong file; the
// 1.3.5 review round 1 could neither prove nor disprove the claim for that reason.
//
// What is pinned here:
//   * `scripts/package-extension.py` declares every member WITH its source path, and
//   * the committed 1.0.0 artifact verifies against those named sources (`PKG1`), and
//   * the gate FAILS on each way the claim could lie: a member taken from the wrong
//     same-named file (`PKG2`), a member drifted from its source (`PKG3`), a membership
//     change (`PKG4`), a build path that would resolve by name or clobber a release
//     (`PKG5`, `PKG6`), and
//   * the map is closed: declared members == shipped members, contract files registered
//     as non-members, no source outside the extension dir (`PKG7`).
//
// Boundary: this card adds the structure gate; the artifact it pins is rebuilt on the card that bumps the version. The ZIP's bytes
// (72,819 B, sha256 3b6382ea…) are unchanged by this suite — it verifies them.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "package-extension.py");
const SOURCE_DIR = path.join(REPOSITORY_ROOT, "hermes-review-extension");
const ARTIFACT = path.join(REPOSITORY_ROOT, "releases", "hermes-review-extension-v1.0.0.zip");

const scratch = await mkdtemp(path.join(os.tmpdir(), "hermes-review-packaging-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Runs the packaging script in the repo root; returns {status, output}. */
function runPython(args) {
  const result = spawnSync("python3", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(result.error, undefined, `python3 ${args.join(" ")} could not start: ${result.error}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function verify(zipPath) {
  return runPython([SCRIPT, "verify", zipPath]);
}

function build(out, extra = []) {
  return runPython([SCRIPT, "build", "--out", out, ...extra]);
}

/**
 * Rewrites a built ZIP into a fixture: replace a member's bytes, drop members, add members.
 * Node has no ZIP writer, so the mutation runs through python — the same stdlib the gate uses.
 */
const MUTATE_PROGRAM = [
  "import sys, zipfile",
  "base, out = sys.argv[1], sys.argv[2]",
  "specs = sys.argv[3:]",
  "with zipfile.ZipFile(base) as archive:",
  "    items = {info.filename: archive.read(info.filename) for info in archive.infolist()}",
  "for spec in specs:",
  "    kind, rest = spec.split(':', 1)",
  "    if kind == 'replace':",
  "        name, source = rest.split('=', 1)",
  "        items[name] = open(source, 'rb').read()",
  "    elif kind == 'drop':",
  "        items.pop(rest, None)",
  "    elif kind == 'add':",
  "        name, source = rest.split('=', 1)",
  "        items[name] = open(source, 'rb').read()",
  "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:",
  "    for name in sorted(items):",
  "        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))",
  "        info.compress_type = zipfile.ZIP_DEFLATED",
  "        archive.writestr(info, items[name])",
  "print(out)",
].join("\n");

const MEMBER_LIST_PROGRAM = [
  "import sys, zipfile",
  "with zipfile.ZipFile(sys.argv[1]) as archive:",
  "    print('\\n'.join(sorted(archive.namelist())))",
].join("\n");

function mutate(base, out, ...specs) {
  const result = runPython(["-c", MUTATE_PROGRAM, base, out, ...specs]);
  assert.equal(result.status, 0, `fixture mutation failed: ${result.output}`);
  return out;
}

function membersOf(zipPath) {
  const result = runPython(["-c", MEMBER_LIST_PROGRAM, zipPath]);
  assert.equal(result.status, 0, `reading ${zipPath} failed: ${result.output}`);
  return result.output.trim().split("\n").filter(Boolean);
}

let gateCount = 0;
function gate(label, run) {
  run();
  gateCount += 1;
  console.log(`[PASS][${label}]`);
}

function scratchFile(name, contents) {
  const file = path.join(scratch, name);
  writeFileSync(file, contents);
  return file;
}

// The declared map, read from the script itself (`map --json`) — the suite asserts the
// DECLARATION, not a second copy of it (a duplicated map is exactly the drift this card is about).
const mapRun = runPython([SCRIPT, "map", "--json"]);
assert.equal(mapRun.status, 0, `the map must be printable:\n${mapRun.output}`);
const memberMap = JSON.parse(mapRun.output);
const declaredMembers = memberMap.members;

// ---------------------------------------------------------------------------
// PKG1: the committed 1.0.0 artifact verifies against its NAMED sources
// ---------------------------------------------------------------------------
gate("PKG1", () => {
  const { status, output } = verify(ARTIFACT);
  assert.equal(status, 0, `the committed 1.0.0 artifact must verify clean:\n${output}`);
  assert.match(output, /PACKAGE VERIFY CLEAN — 9\/9 members byte-identical to their named sources/);
  assert.match(output, /README\.md <- hermes-review-extension\/README\.md .*byte-identical to its named source/);
  // The colliding name is asserted, not ignored: the repo root README differs and is named.
  assert.match(output, /same name elsewhere: \.\/README\.md .*differs — asserted/);
  // Every member is printed with the source it came from.
  for (const { member, source } of declaredMembers) {
    assert.ok(
      output.includes(`${member} <- hermes-review-extension/${source}`),
      `the gate must name the source of member ${member}`
    );
  }
  // Derived from the artifact's own name, so a version bump cannot leave a stale literal behind.
  const artifactVersion = /v(\d+\.\d+\.\d+)\.zip$/.exec(path.basename(ARTIFACT))[1];
  const escapedVersion = artifactVersion.replace(/\./g, "\\.");
  assert.match(
    output,
    new RegExp(`the packaged manifest version \\(${escapedVersion}\\) matches the release filename \\(${escapedVersion}\\)`)
  );
});

// ---------------------------------------------------------------------------
// PKG2: positive control — a member taken from the wrong same-named file FAILS, and the
//       gate names the decoy (this is the failure mode that shipped silently)
// ---------------------------------------------------------------------------
gate("PKG2", () => {
  const base = build(path.join(scratch, "good.zip"));
  assert.equal(base.status, 0, `the map must build cleanly:\n${base.output}`);
  const wrong = mutate(
    path.join(scratch, "good.zip"),
    path.join(scratch, "wrong-readme.zip"),
    `replace:README.md=${path.join(REPOSITORY_ROOT, "README.md")}`
  );
  const { status, output } = verify(wrong);
  assert.equal(status, 1, `the repo root README as the README.md member must fail:\n${output}`);
  assert.match(output, /README\.md differs from its named source/);
  assert.match(output, /README\.md is byte-identical to the same-named file .*README\.md — the member came from a plausible-but-wrong file resolved by name/);
  assert.match(output, /1 FINDING\(S\)|FINDING\(S\)/);
});

// ---------------------------------------------------------------------------
// PKG3: a member drifted from its named source FAILS (the 1.3.4-style divergence: right
//       name, older bytes)
// ---------------------------------------------------------------------------
gate("PKG3", () => {
  const drifted = scratchFile(
    "view.css.drift",
    `${readFileSync(path.join(SOURCE_DIR, "view.css"), "utf8")}\n/* drifted */\n`
  );
  const zip = mutate(
    path.join(scratch, "good.zip"),
    path.join(scratch, "drifted.zip"),
    `replace:view.css=${drifted}`
  );
  const { status, output } = verify(zip);
  assert.equal(status, 1, `a drifted member must fail:\n${output}`);
  assert.match(output, /view\.css differs from its named source hermes-review-extension\/view\.css/);
});

// ---------------------------------------------------------------------------
// PKG4: membership changes FAIL — a dropped member and an unmapped extra member
// ---------------------------------------------------------------------------
gate("PKG4", () => {
  const dropped = mutate(
    path.join(scratch, "good.zip"),
    path.join(scratch, "dropped.zip"),
    "drop:view.css"
  );
  const droppedRun = verify(dropped);
  assert.equal(droppedRun.status, 1, `a dropped member must fail:\n${droppedRun.output}`);
  assert.match(droppedRun.output, /every mapped member is present in the ZIP — MISSING: \['view\.css'\]/);

  const stray = scratchFile("notes.txt", "stray\n");
  const extra = mutate(
    path.join(scratch, "good.zip"),
    path.join(scratch, "extra.zip"),
    `add:notes.txt=${stray}`
  );
  const extraRun = verify(extra);
  assert.equal(extraRun.status, 1, `an unmapped member must fail:\n${extraRun.output}`);
  assert.match(extraRun.output, /every ZIP member is in the map \(nothing resolved implicitly by name\) — UNMAPPED: \['notes\.txt'\]/);
});

// ---------------------------------------------------------------------------
// PKG5: the build path is reproducible from the map, and refuses a source dir that would
//       resolve README.md by name (the repo root — the declined prescription)
// ---------------------------------------------------------------------------
gate("PKG5", () => {
  const first = build(path.join(scratch, "rebuild-a.zip"));
  const second = build(path.join(scratch, "rebuild-b.zip"));
  assert.equal(first.status, 0, `build must succeed:\n${first.output}`);
  assert.equal(second.status, 0, `build must succeed:\n${second.output}`);
  assert.equal(
    readFileSync(path.join(scratch, "rebuild-a.zip")).toString("base64"),
    readFileSync(path.join(scratch, "rebuild-b.zip")).toString("base64"),
    "two builds from the same map must produce identical bytes"
  );
  const rebuilt = verify(path.join(scratch, "rebuild-a.zip"));
  assert.equal(rebuilt.status, 0, `a build from the map must verify clean:\n${rebuilt.output}`);

  const rootSource = build(path.join(scratch, "root-source.zip"), ["--source-dir", "."]);
  assert.equal(rootSource.status, 1, `the repo root as source dir must be refused:\n${rootSource.output}`);
  assert.match(rootSource.output, /the source dir must not be the repo root/);
});

// ---------------------------------------------------------------------------
// PKG6: a released artifact is never rebuilt in place silently
// ---------------------------------------------------------------------------
gate("PKG6", () => {
  const before = readFileSync(ARTIFACT);
  const attempt = build(ARTIFACT);
  assert.equal(attempt.status, 1, `building over the released artifact must be refused:\n${attempt.output}`);
  assert.match(attempt.output, /exists — a released artifact is not rebuilt in place/);
  assert.equal(
    readFileSync(ARTIFACT).equals(before),
    true,
    "the committed artifact's bytes must be untouched by a refused build"
  );
});

// ---------------------------------------------------------------------------
// PKG7: the map is explicit and closed — declared members == shipped members, every source
//       inside the extension dir, contract files registered as non-members
// ---------------------------------------------------------------------------
gate("PKG7", () => {
  assert.equal(declaredMembers.length, 9, "the map declares exactly the 9 shipped members");
  assert.deepEqual(
    declaredMembers.map((entry) => entry.member).sort(),
    membersOf(ARTIFACT),
    "the declared member set must equal the artifact's member set"
  );
  const readme = declaredMembers.find((entry) => entry.member === "README.md");
  assert.ok(readme, "README.md must be a declared member");
  assert.equal(readme.source, "README.md", "the README.md member's named source is the extension dir's own README.md");
  // No declared source escapes the extension source dir, and none is a repo-root path.
  for (const { member, source, why } of declaredMembers) {
    assert.equal(path.isAbsolute(source), false, `${member}'s source must be relative to the source dir`);
    assert.equal(source.startsWith(".."), false, `${member}'s source must not leave the source dir`);
    assert.ok(source.trim().length > 0, `${member} must name a source`);
    assert.ok(why.trim().length > 0, `${member} must say why that source is the member`);
  }
  // The three contract files that live in the source dir are registered as non-members, with reasons.
  const nonMembers = memberMap.non_members;
  for (const contractFile of [".authoring-guide.md", "manifest.schema.json", "msty-extension-api.d.ts"]) {
    const entry = nonMembers.find((item) => item.path === contractFile);
    assert.ok(entry, `${contractFile} must be registered as a non-member`);
    assert.ok(entry.why.trim().length > 0, `${contractFile}'s non-member entry must carry a reason`);
    assert.equal(membersOf(ARTIFACT).includes(contractFile), false, `${contractFile} must never be a member`);
  }
  // The rule is stated where the map is: the packaged README is the extension's own, and the
  // repo root README is named as the file that is NOT it.
  assert.match(readme.why, /the repo root README\.md is developer docs and is never a member/);
});

console.log(`Hermes Review packaging contract checks passed (${gateCount} gates).`);
