// t_4a9ba0ca — pane polish contract: the waiting state's spinner, and the
// expand/collapse path that must not rebuild the list.
//
// Both halves are DRIVEN against the real `view.js` frame over the strict fake
// DOM this project's pane suites use (no jsdom), because both are claims about
// what the frame does when a user acts on it:
//
//   PP1  the waiting state carries a spinner — one decorative mark inside the
//        running panel, its copy untouched — and the mark is gone once the
//        review completes (the running panel is gone with it)
//   PP2  toggling ONE row touches that row only: every other row's container,
//        the list container and the toggled row's own head are the SAME DOM
//        nodes afterwards (node identity, not equal markup — the assertion that
//        cannot be satisfied by coincidence)
//   PP3  CONTROL — the 1.3.8 toggle path, restored into a scratch copy of this
//        very file, FAILS PP2's assertion (that is the "slight freeze" the user
//        reported: one click rebuilt every row and re-attached every handler)
//   PP4  a sibling's toggle leaves an OPEN edit field alone: the textarea is the
//        same node, still in the frame, with the draft it held
//   PP5  a toggle round trip returns the row to exactly its previous shape —
//        the detail subtree removed, the chevron repainted closed, the list's
//        children unchanged in number — so the local path is complete, not just
//        fast
//
// The colours and the reduced-motion rule are `view.css`'s (pinned by
// `tests/hermes-review-pane-structure-contract.mjs` PS13), and the field's
// scrollbar contrast is `tests/hermes-review-token-vocabulary-contract.mjs`
// VS9; this file is about behaviour.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerCssImportHook } from "./helpers/css-import-hook.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "hermes-review-extension");

const { COPY, buildPaneModel } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "review-pane.js")).href);
const { HISTORY_STORAGE_KEY } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "review-history.js")).href);
const { revisionBody, revisionReview } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "review-core.js")).href);

registerCssImportHook();
const { mount } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "view.js")).href);

// ---------------------------------------------------------------------------
// The strict frame host: a DOM of plain objects, storage keyed by the ACTIVE
// chat exactly as the host's `storage.chat` is, and a way to fire surface
// events (the lifecycle carriers the frame subscribes to).
// ---------------------------------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.className = ""; this.textContent = "";
    this.dataset = {}; this.listeners = new Map(); this.style = new FakeStyle();
    this.disabled = false; this.type = ""; this.value = ""; this.placeholder = ""; this.rows = 0;
  }
  get ownerDocument() { return FakeDocument.instance; }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children = this.children.filter((node) => node !== child); return child; }
  setAttribute(name, value) { this[`attr_${name}`] = value; }
  addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
  removeEventListener() {}
}
class FakeStyle {
  constructor() { this.props = new Map(); }
  setProperty(name, value) { this.props.set(name, String(value)); }
  removeProperty(name) { this.props.delete(name); }
  getPropertyValue(name) { return this.props.get(name) ?? ""; }
}
Object.defineProperty(FakeNode.prototype, "classList", {
  get() {
    const node = this;
    return { add(name) { if (!String(node.className).split(/\s+/).includes(name)) node.className = `${node.className} ${name}`.trim(); } };
  }
});
class FakeDocument {
  static instance = null;
  constructor() { FakeDocument.instance = this; }
  createElement(tag) { return new FakeNode(tag); }
  createElementNS(_ns, tag) { return new FakeNode(tag); }
}

function frameHost({ activeChat, docs }) {
  const handlers = new Map();
  const surface = {
    context: null,
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {};
    }
  };
  const msty = {
    surface,
    events: { subscribe() { return () => {}; } },
    theme: { colorScheme: "light", tokens: {}, getTokens: () => ({}) },
    ui: { async confirm() { return { confirmed: true }; }, update() {} },
    notifications: { async show() {} },
    composer: { async get() { return { text: "", canEdit: true }; }, async clear() {}, async setText() {} },
    context: { async getCurrentChat() { return { chat: { id: activeChat } }; } },
    storage: {
      local: { async get() { return undefined; }, async set() {} },
      chat: {
        async get(key) { return docs.get(activeChat)?.[key]; },
        async set(key, value) { if (!docs.has(activeChat)) docs.set(activeChat, {}); docs.get(activeChat)[key] = value; }
      }
    },
    messages: { async list() { return []; } },
    models: { async getStatus() { return { ready: true, configured: true, source: "assignment" }; }, async infer() { return { json: { title: "T", summary: "s", issues: [] } }; } }
  };
  /** Delivers one host event on every handler subscribed to `type`. */
  const fire = (type, event) => {
    for (const handler of handlers.get(type) ?? []) handler(event);
  };
  return { msty, fire };
}

// ---------------------------------------------------------------------------
// Walking the fake DOM.
// ---------------------------------------------------------------------------
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}
const hasClass = (node, className) => String(node.className ?? "").split(/\s+/).includes(className);
const byClass = (root, className) => walk(root).filter((node) => hasClass(node, className));
const byText = (root, text) => walk(root).filter((node) => node.textContent === text);
const textOf = (node) => walk(node).map((child) => child.textContent).filter(Boolean).join("");
function click(node) {
  assert.ok(node, "the gate must find the node it clicks");
  const handlers = node.listeners?.get("click") ?? [];
  assert.ok(handlers.length > 0, `the node clicked must have a click handler (class "${node.className}")`);
  for (const handler of handlers) handler({ type: "click" });
}
const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const CHAT = "chat-a";
const STORAGE_KEY = `${HISTORY_STORAGE_KEY}:${CHAT}`;
function entryOf(index, overrides = {}) {
  return {
    id: `review-${index}`,
    title: `Review ${index} found 1 issue`,
    createdAt: new Date(Date.UTC(2026, 8, 22, 10, index)).toISOString(),
    messageCount: 4,
    modelLabel: "your reviewer model",
    summary: `Summary for review ${index}.`,
    editedBody: null,
    chatId: CHAT,
    issues: [
      { severity: "High", title: `Issue ${index}`, location: `Message ${index}`, problem: "Problem text.", correction: "Correction text." }
    ],
    ...overrides
  };
}
const ENTRIES = [entryOf(0), entryOf(1), entryOf(2)];
/** Rows render newest-first, so row 0 is the LAST entry in the fixture. */
const NEWEST = ENTRIES[ENTRIES.length - 1];
const DERIVED_BODY = revisionBody(revisionReview(NEWEST));

/** Mounts the tree's frame over a stored document; returns the frame + root. */
async function mountFrame(entries, context = { chat: { id: CHAT } }, mountFn = mount, docs = null) {
  const store = docs ?? new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries } }]]);
  const frame = frameHost({ activeChat: CHAT, docs: store });
  const root = new FakeNode("div");
  new FakeDocument();
  mountFn({ root, msty: frame.msty, context });
  await settle();
  return { ...frame, root, docs: store };
}

const rowsOf = (root) => {
  const lists = byClass(root, "rv-list");
  assert.equal(lists.length, 1, "the review rows live in exactly one list container");
  return lists[0].children.filter((child) => hasClass(child, "rv-row"));
};
const headOf = (row) => {
  const head = row.children.find((child) => hasClass(child, "rv-row-head"));
  assert.ok(head, "the row carries its own collapse/expand head");
  return head;
};
const detailOf = (row) => row.children.find((child) => hasClass(child, "rv-row-detail")) ?? null;

/**
 * The claim PP2 pins, as a finding list — so the SAME check can be run against a
 * mutated scratch frame and required to FAIL (PP3).
 * @param {any} root
 */
function localToggleFindings(root) {
  const findings = [];
  const rowsBefore = rowsOf(root);
  const listBefore = byClass(root, "rv-list")[0];
  if (rowsBefore.length < 3) findings.push(`expected 3 rows, saw ${rowsBefore.length}`);
  const toggledHead = headOf(rowsBefore[0]);
  click(toggledHead);
  const rowsAfter = rowsOf(root);

  if (rowsAfter.length !== rowsBefore.length) findings.push("the toggle changed the number of rows");
  if (byClass(root, "rv-list")[0] !== listBefore) findings.push("the toggle REPLACED the list container");
  // The toggled row itself: its head is the same node, and its detail opened.
  if (rowsAfter[0] !== rowsBefore[0]) findings.push("the toggled row's own container was rebuilt");
  if (headOf(rowsAfter[0]) !== toggledHead) findings.push("the toggled row's head node was rebuilt");
  if (detailOf(rowsAfter[0]) === null) findings.push("the clicked row did not expand");
  // Every OTHER row: the same DOM node, untouched.
  for (const index of [1, 2]) {
    if (rowsAfter[index] !== rowsBefore[index]) {
      findings.push(`row ${index} was rebuilt by a toggle of row 0 (node identity lost)`);
    }
  }
  return findings;
}

/**
 * The PP4 claim as a finding list, so the same check can be run against the
 * mutated (pre-fix) frame and required to FAIL: opens the edit state on the
 * first row, then toggles a SIBLING row through its own head.
 * @param {any} root
 */
function editSurvivalFindings(root) {
  const findings = [];
  click(headOf(rowsOf(root)[0]));
  const editButton = byText(byClass(root, "rv-row-actions")[0], COPY.editAction)[0];
  if (!editButton) return ["the expanded row offers no way into its edit state"];
  click(editButton);
  const field = byClass(root, "rv-editbody")[0];
  if (!field) return ["the edit state rendered no field"];
  if (field.value !== DERIVED_BODY) findings.push("the edit field was not seeded with the derived review body");
  const draft = "my own words";
  field.value = draft;
  for (const handler of field.listeners.get("input") ?? []) handler({ type: "input" });

  click(headOf(rowsOf(root)[1]));

  if (byClass(root, "rv-editbody")[0] !== field) findings.push("a sibling toggle REPLACED the open edit field's DOM node");
  if (!walk(root).includes(field)) findings.push("a sibling toggle detached the open edit field");
  if (field.value !== draft) findings.push("a sibling toggle discarded the typed draft");
  if (detailOf(rowsOf(root)[1]) === null) findings.push("the sibling row did not open (the check is not vacuous)");
  return findings;
}

let gateCount = 0;
/** @param {string} name @param {() => any} body */
const gate = async (name, body) => {
  try {
    await body();
  } catch (error) {
    console.error(`[FAIL][${name}]`);
    throw error;
  }
  gateCount += 1;
  console.log(`[PASS][${name}]`);
};

// ---------------------------------------------------------------------------
// PP1: the waiting state spins, and the mark is gone with the state
// ---------------------------------------------------------------------------
await gate("PP1", async () => {
  const runningContext = { chat: { id: CHAT }, review: { phase: "running", chatId: CHAT, instruction: "focus on citations" } };
  const { root, fire } = await mountFrame([], runningContext);

  const panel = byClass(root, "rv-running");
  assert.equal(panel.length, 1, "the running phase renders its progress panel");
  const marks = byClass(root, "rv-spinner");
  assert.equal(marks.length, 1, "the waiting state renders exactly ONE spinner mark");
  assert.equal(marks[0].tagName, "span", "the mark is a real element the stylesheet can draw");
  assert.equal(marks[0].parentNode, panel[0], "the mark sits inside the running panel");
  assert.equal(marks[0]["attr_aria-hidden"], "true", "the mark is decorative — hidden from assistive tech");
  // The mark carries no copy of its own: the state's words are unchanged.
  assert.equal(textOf(marks[0]), "", "the spinner renders no text");
  assert.equal(textOf(byClass(root, "rv-running-title")[0]), COPY.running, "the waiting copy is exactly as it was");
  assert.equal(
    textOf(byClass(root, "rv-running-instruction")[0]),
    "focus on citations",
    "the focus line is exactly as it was"
  );

  // Completion: the mark is gone, because its whole state is.
  fire("surface.updated", {
    data: { context: { chat: { id: CHAT }, review: { phase: "complete", chatId: CHAT, completionBody: "Reviewed 3 recent messages." } } }
  });
  await settle();
  assert.equal(byClass(root, "rv-running").length, 0, "the running panel is gone once the review completes");
  assert.equal(byClass(root, "rv-spinner").length, 0, "and the spinner is gone with the state it belongs to");
  assert.equal(byClass(root, "rv-callout--success").length, 1, "the completion callout is what renders instead");
});

// ---------------------------------------------------------------------------
// PP2: a toggle touches ONE row — node identity, not equal markup
// ---------------------------------------------------------------------------
await gate("PP2", async () => {
  const { root } = await mountFrame(ENTRIES);
  assert.deepEqual(localToggleFindings(root), [], "toggling one row must leave every other row's DOM node alive");
});

// ---------------------------------------------------------------------------
// PP3: CONTROL — the 1.3.8 toggle path fails PP2 and PP4
// ---------------------------------------------------------------------------
await gate("PP3", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "hermes-review-polish-"));
  try {
    for (const member of ["README.md", "extension.js", "manifest.json", "review-core.js", "review-history.js", "review-pane.js", "view.js"]) {
      await mkdir(path.dirname(path.join(scratch, member)), { recursive: true });
      await writeFile(path.join(scratch, member), readFileSync(path.join(PACKAGE_ROOT, member)));
    }
    // The shipped file, with the 1.3.8 row head restored: flip the state and
    // re-render the whole list (which is what the user felt as a freeze).
    const shipped = readFileSync(path.join(PACKAGE_ROOT, "view.js"), "utf8");
    const local = "    head.addEventListener(\"click\", () => toggleRow(row.id));";
    assert.ok(shipped.includes(local), "the mutation anchor is present in the shipped entry");
    const prefixToggle = [
      "    head.addEventListener(\"click\", () => {",
      "      state.expandedIds = toggleExpandedId(state.expandedIds, row.id);",
      "      renderBody();",
      "    });"
    ].join("\n");
    const mutated = shipped.replace(local, prefixToggle);
    assert.notEqual(mutated, shipped, "the control really restored the pre-fix toggle path");
    await writeFile(path.join(scratch, "view.js"), mutated);

    const { mount: mountMutated } = await import(pathToFileURL(path.join(scratch, "view.js")).href);
    const identity = await mountFrame(ENTRIES, { chat: { id: CHAT } }, mountMutated);
    const identityFindings = localToggleFindings(identity.root);
    assert.ok(identityFindings.length > 0, "the pre-fix toggle path MUST fail PP2 — this is the freeze the card fixes");
    console.log(`[CTRL][PP3] pre-fix toggle -> ${identityFindings[0]}`);

    const edit = await mountFrame(ENTRIES, { chat: { id: CHAT } }, mountMutated);
    const editFindings = editSurvivalFindings(edit.root);
    assert.ok(editFindings.length > 0, "the pre-fix toggle path MUST fail PP4 — it rebuilt the row being edited");
    console.log(`[CTRL][PP3] pre-fix toggle vs an open edit -> ${editFindings[0]}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PP4: a sibling's toggle cannot disturb the row being edited
// ---------------------------------------------------------------------------
await gate("PP4", async () => {
  const { root } = await mountFrame(ENTRIES);
  assert.deepEqual(
    editSurvivalFindings(root),
    [],
    "a sibling's toggle must leave an open edit field alone: the same node, in frame, with the draft it held"
  );
});

// ---------------------------------------------------------------------------
// PP5: the local toggle is complete — a round trip restores the row exactly
// ---------------------------------------------------------------------------
await gate("PP5", async () => {
  const { root } = await mountFrame(ENTRIES);
  const row = rowsOf(root)[0];
  const head = headOf(row);
  const before = walk(root).length;

  click(head);
  const detail = detailOf(rowsOf(root)[0]);
  assert.ok(detail, "the row expanded");
  assert.equal(textOf(byClass(detail, "rv-summary")[0]), NEWEST.summary, "the expanded row renders the review's own summary");
  assert.equal(String(headOf(rowsOf(root)[0]).children[0]["attr_class"]), "rv-icon rv-chev--open", "the chevron repaints open");
  assert.equal(rowsOf(root).length, 3, "the list still holds its three rows");

  click(head);
  assert.equal(detailOf(rowsOf(root)[0]), null, "the second click removes the detail subtree");
  assert.equal(String(head.children[0]["attr_class"]), "rv-icon rv-chev--closed", "the chevron repaints closed");
  assert.equal(walk(root).length, before, "the row is back to exactly the node count it started with");
  assert.equal(headOf(rowsOf(root)[0]), head, "on the same head node — nothing was rebuilt to get back here");
});

console.log(`Hermes Review pane polish contract checks passed (${gateCount} gates).`);
