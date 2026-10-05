// t_db84b23e contract: editing a stored review's TEXT in the pane.
// ---------------------------------------------------------------------------
// The card's slice, gate by gate, driven against the REAL view.js frame through
// the strict fake DOM this project's pane suites use (no jsdom): mount the frame,
// click the row, type in the field, watch what reaches storage and the composer.
//
//   PE1  the way IN is a first-class button: the expanded row's own action row
//        carries Edit first, and a read-only frame still shows exactly ONE
//        primary action (the footer's) and no field at all
//   PE2  Edit opens the state IN FRAME: the constant framing sentence drawn above
//        a textarea seeded with the derived body, the row's own Cancel + Save
//        beside it, the footer untouched
//   PE3  Save persists `editedBody` on THAT entry in THAT chat's document only,
//        leaves the review's own summary/issues/title alone, and writes nothing
//        for any other chat
//   PE4  Cancel writes nothing at all and restores the read-only detail
//   PE5  a FRESH mount renders the saved edit verbatim (`.rv-stored`, never
//        re-parsed into issue rows) under the `edited` marker
//   PE6  "Send to composer" then places framing + the EDITED body in the composer
//        — the wiring, not just the prompt builder
//
// The shape claims (class names, the marker's draw, the dummy's action order) are
// pinned by tests/hermes-review-pane-structure-contract.mjs (PS8, PS12) and the
// colours by tests/hermes-review-token-vocabulary-contract.mjs (VS8); this file
// is about behaviour.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION_FRAMING, revisionBody, revisionReview } from "../hermes-review-extension/review-core.js";
import { registerCssImportHook } from "./helpers/css-import-hook.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "hermes-review-extension");
const asUrl = (file) => path.join(PACKAGE_ROOT, file).replace(/\\/g, "/");

const { COPY, buildPaneModel } = await import(asUrl("review-pane.js"));
const { HISTORY_STORAGE_KEY } = await import(asUrl("review-history.js"));

registerCssImportHook();
const { mount } = await import(asUrl("view.js"));

// ---------------------------------------------------------------------------
// The strict frame host: a DOM of plain objects, and a storage layer keyed by
// the ACTIVE chat exactly as the host's `storage.chat` is.
// ---------------------------------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.className = ""; this.textContent = "";
    this.dataset = {}; this.listeners = new Map(); this.style = new FakeStyle();
    this.disabled = false;
    this.type = ""; this.value = ""; this.placeholder = ""; this.rows = 0;
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

/** Builds a strict frame host: per-chat composite-key storage + composer capture. */
function frameHost({ activeChat, docs }) {
  const handlers = new Map();
  const eventHandlers = [];
  const chatWrites = [];
  const composerTexts = [];
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
    events: { subscribe(handler) { eventHandlers.push(handler); return () => {}; } },
    theme: { colorScheme: "light", tokens: {}, getTokens: () => ({}) },
    ui: { async confirm() { return { confirmed: true }; }, update() {}, async updateSurface() { return { updated: true }; } },
    notifications: { async show() {} },
    composer: {
      async get() { return { text: "", canEdit: true }; },
      async clear() {},
      async setText(text) { composerTexts.push(text); }
    },
    context: { async getCurrentChat() { return { chat: { id: activeChat } }; } },
    storage: {
      local: { async get() { return undefined; }, async set() {} },
      chat: {
        async get(key) { return docs.get(activeChat)?.[key]; },
        async set(key, value) {
          chatWrites.push({ chatId: activeChat, key });
          if (!docs.has(activeChat)) docs.set(activeChat, {});
          docs.get(activeChat)[key] = value;
        }
      }
    },
    messages: { async list() { return []; } },
    models: {
      async getStatus() { return { ready: true, configured: true, source: "assignment" }; },
      async infer() { return { json: { title: "T", summary: "s", issues: [] } }; }
    }
  };
  return { msty, composerTexts, chatWrites };
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
// Fixtures + the shared driving steps.
// ---------------------------------------------------------------------------
const CHAT = "chat-a";
const STORAGE_KEY = `${HISTORY_STORAGE_KEY}:${CHAT}`;
const ENTRY = {
  id: "review-1",
  title: "Review found 1 issue",
  createdAt: "2026-09-22T10:00:00.000Z",
  messageCount: 3,
  modelLabel: "your reviewer model",
  summary: "One issue found.",
  editedBody: null,
  chatId: CHAT,
  issues: [
    { severity: "High", title: "Issue 1", location: "Message 4", problem: "Problem text.", correction: "Correction text." }
  ]
};
const DERIVED_BODY = revisionBody(revisionReview(ENTRY));
assert.equal(DERIVED_BODY.startsWith("Independent review summary:"), true, "precondition: the derived body is the markdown the prompt sends");

/** A mounted frame with chat-a's one stored review, its row expanded. */
async function mountExpandedRow(docs) {
  const frame = frameHost({ activeChat: CHAT, docs });
  /** @type {any} */
  const root = new FakeNode("div");
  new FakeDocument();
  mount({ root, msty: frame.msty, context: { chat: { id: CHAT } } });
  await settle();
  const head = byClass(root, "rv-row-head");
  assert.equal(head.length, 1, "precondition: chat-a's one review renders one row head");
  click(head[0]);
  await settle();
  return { frame, root };
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
// PE1: the way in — Edit is part of the row, and read-only stays read-only
// ---------------------------------------------------------------------------
await gate("PE1", async () => {
  const docs = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [ENTRY] } }]]);
  const { root } = await mountExpandedRow(docs);

  // The row still renders EXACTLY what it rendered before this card: the derived
  // summary and the parsed issue rows, with no marker and no stored text.
  assert.equal(byClass(root, "rv-summary").length, 1, "the unexpanded review's derived summary still renders");
  assert.equal(byClass(root, "rv-issue").length, 1, "the issue row still renders from the parsed review");
  assert.equal(byClass(root, "rv-stored").length, 0, "a review that was never edited renders no stored body");
  assert.equal(byClass(root, "rv-edited").length, 0, "a review that was never edited renders no marker");
  assert.equal(byClass(root, "rv-editbody").length, 0, "a read-only frame renders no editable field");
  assert.equal(byClass(root, "rv-framing").length, 0, "a read-only frame renders no framing block");

  // THREE actions, in the dummy's order (PS8 pins the same order at the source):
  // Edit first — it is the way into the state, not a secondary affordance.
  const actions = byClass(root, "rv-row-actions");
  assert.equal(actions.length, 1, "the expanded row has its own action row");
  const buttons = actions[0].children.filter((child) => child.tagName === "button");
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [COPY.editAction, COPY.sendAction, COPY.deleteAction],
    "the row's actions are Edit, then Send to composer, then Delete"
  );
  assert.equal(buttons[0].className, "rv-btn", "the Edit button uses the pane's plain raised recipe, not a variant");
  assert.equal(buttons[0].type, "button", "the Edit button is a real button element");

  // And the frame still carries exactly ONE primary action: the footer's.
  const primaries = byClass(root, "rv-btn--primary");
  assert.equal(primaries.length, 1, "a read-only frame shows exactly one primary-classed action");
  assert.equal(primaries[0].textContent, COPY.footerButton, "and that one is the footer's own action");

  // The model half of the same claim: the row carries the edit data the frame
  // needs, and no row is in the edit state.
  const model = buildPaneModel({ entries: [ENTRY], chatId: CHAT });
  assert.equal(model.editingId, null, "no row is in the edit state to begin with");
  assert.equal(model.rows[0].editing, false, "the row model agrees");
  assert.equal(model.rows[0].editedBody, null, "the row model carries no edited body");
  assert.equal(model.rows[0].isEdited, false, "the row model reports the review as unedited");
  assert.equal(model.rows[0].draftBody, DERIVED_BODY, "the field's initial value IS the derived body the prompt would send");
  assert.equal(model.framing, REVISION_FRAMING, "the pane draws review-core.js' own framing export, never a copy");
});

// ---------------------------------------------------------------------------
// PE2: Edit opens the state in frame — framing above the field, Cancel + Save
// ---------------------------------------------------------------------------
await gate("PE2", async () => {
  const docs = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [ENTRY] } }]]);
  const { root } = await mountExpandedRow(docs);
  click(byText(byClass(root, "rv-row-actions")[0], COPY.editAction)[0]);
  await settle();

  const field = byClass(root, "rv-editbody")[0];
  assert.equal(byClass(root, "rv-editbody").length, 1, "the row now carries ONE editable field");
  assert.equal(field.tagName, "textarea", "the field is a textarea");
  assert.equal(field.value, DERIVED_BODY, "the field is seeded with the derived review body");
  assert.equal(field.value.includes(REVISION_FRAMING), false, "the constant framing sentence is NOT inside the field");
  assert.equal(field["attr_aria-label"], COPY.editFieldLabel, "the field carries its accessible name");

  // The framing block is drawn ABOVE the field, inside the same item.
  const framing = byClass(root, "rv-framing");
  assert.equal(framing.length, 1, "the edit state draws the framing block");
  assert.equal(textOf(framing[0]).includes(REVISION_FRAMING), true, "the framing block carries the constant sentence");
  assert.equal(textOf(framing[0]).includes(COPY.editFramingLabel), true, "and labels it as the part that is not editable");

  const detail = byClass(root, "rv-row-detail")[0];
  assert.equal(detail.children.indexOf(framing[0]) < detail.children.indexOf(field), true, "the framing reads before the field");

  // The read-only body is replaced, not duplicated.
  assert.equal(byClass(root, "rv-summary").length, 0, "the derived summary is not drawn beside the field");
  assert.equal(byClass(root, "rv-issue").length, 0, "nor are the parsed issue rows");

  // Cancel (ghost) + Save (primary) live in THAT item's own action row.
  const actions = byClass(root, "rv-row-actions");
  assert.equal(actions.length, 1, "the edit state keeps one action row, inside the item being edited");
  const buttons = actions[0].children.filter((child) => child.tagName === "button");
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [COPY.cancelAction, COPY.saveAction],
    "the edit state carries Cancel then Save"
  );
  assert.equal(buttons[0].className, "rv-btn rv-btn--ghost", "Cancel is the pane's neutral ghost action");
  assert.equal(buttons[1].className, "rv-btn rv-btn--primary", "Save is the state's one filled action");
  const detailOwner = byClass(root, "rv-row-detail").find((node) => walk(node).includes(field));
  assert.equal(walk(detailOwner).includes(buttons[1]), true, "Save is in frame — the same item block as the field, not the footer");

  // The footer is untouched: two primaries in the frame, and one of them is
  // still the footer's `Review`.
  const primaries = byClass(root, "rv-btn--primary");
  assert.equal(primaries.length, 2, "the edit state adds Save to the footer's own primary action");
  assert.equal(
    primaries.some((node) => node.textContent === COPY.footerButton),
    true,
    "the footer keeps its own primary action while a row is being edited"
  );
});

// ---------------------------------------------------------------------------
// PE3: Save persists the edited body on that one entry, in that one chat
// ---------------------------------------------------------------------------
await gate("PE3", async () => {
  const otherChatDoc = { [`${HISTORY_STORAGE_KEY}:chat-b`]: { schemaVersion: 1, chatId: "chat-b", entries: [] } };
  const docs = new Map([
    [CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [ENTRY] } }],
    ["chat-b", JSON.parse(JSON.stringify(otherChatDoc))]
  ]);
  const otherBefore = JSON.stringify(docs.get("chat-b"));
  const { frame, root } = await mountExpandedRow(docs);
  click(byText(byClass(root, "rv-row-actions")[0], COPY.editAction)[0]);
  await settle();

  const typed = "My own words.\n\n1. Fix the density figure.";
  const field = byClass(root, "rv-editbody")[0];
  field.value = typed;
  for (const handler of field.listeners.get("input") ?? []) handler({ type: "input" });
  click(byText(byClass(root, "rv-row-actions")[0], COPY.saveAction)[0]);
  await settle();

  const stored = docs.get(CHAT)[STORAGE_KEY].entries;
  assert.equal(stored.length, 1, "the save updates the entry, it does not append one");
  assert.equal(stored[0].editedBody, typed, "the typed text is stored VERBATIM (line breaks included)");
  assert.equal(stored[0].id, ENTRY.id, "the same entry was updated");
  assert.equal(stored[0].summary, ENTRY.summary, "the review's own summary is untouched — editing is not re-deriving");
  assert.equal(stored[0].issues.length, 1, "the review's own issue data is untouched");
  assert.equal(stored[0].title, ENTRY.title, "the header's original count/severity data is untouched");
  assert.equal(JSON.stringify(docs.get("chat-b")), otherBefore, "no other chat's document is touched");
  const historyWrites = frame.chatWrites.filter((write) => String(write.key).startsWith("review-history:"));
  assert.equal(historyWrites.length, 1, "the save writes ONE history document");
  assert.equal(
    historyWrites.every((write) => write.chatId === CHAT && write.key === STORAGE_KEY),
    true,
    `that write went to chat-a's own composite key (saw ${JSON.stringify(historyWrites)})`
  );
  assert.equal(frame.composerTexts.length, 0, "saving is not sending — the composer is untouched");

  // The pane itself leaves the edit state and shows the saved text verbatim.
  assert.equal(byClass(root, "rv-editbody").length, 0, "the field is gone after the save");
  assert.equal(byClass(root, "rv-stored").length, 1, "the row now renders its stored body");
  assert.equal(textOf(byClass(root, "rv-stored")[0]), typed, "the stored body is the edited text, verbatim");
  assert.equal(byClass(root, "rv-issue").length, 0, "the edited body is never re-parsed into issue rows");
  assert.equal(byClass(root, "rv-edited").length, 1, "the row carries the edited marker");
});

// ---------------------------------------------------------------------------
// PE4: Cancel writes nothing and restores the read-only detail
// ---------------------------------------------------------------------------
await gate("PE4", async () => {
  const docs = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [ENTRY] } }]]);
  const before = JSON.stringify(docs.get(CHAT)[STORAGE_KEY]);
  const { frame, root } = await mountExpandedRow(docs);
  click(byText(byClass(root, "rv-row-actions")[0], COPY.editAction)[0]);
  await settle();
  const field = byClass(root, "rv-editbody")[0];
  field.value = "typed but abandoned";
  for (const handler of field.listeners.get("input") ?? []) handler({ type: "input" });
  click(byText(byClass(root, "rv-row-actions")[0], COPY.cancelAction)[0]);
  await settle();

  assert.equal(
    frame.chatWrites.filter((write) => String(write.key).startsWith("review-history:")).length,
    0,
    "Cancel writes nothing to the history store"
  );
  assert.equal(JSON.stringify(docs.get(CHAT)[STORAGE_KEY]), before, "the stored document is byte-identical after a cancel");
  assert.equal(byClass(root, "rv-editbody").length, 0, "the field is gone");
  assert.equal(byClass(root, "rv-framing").length, 0, "and so is the framing block");
  assert.equal(byClass(root, "rv-stored").length, 0, "nothing was stored, so no stored body renders");
  assert.equal(byClass(root, "rv-edited").length, 0, "and no marker");
  assert.equal(byClass(root, "rv-summary").length, 1, "the read-only detail is back, exactly as before");
  assert.equal(byClass(root, "rv-issue").length, 1, "the parsed issue row is back");
  assert.deepEqual(
    byClass(root, "rv-row-actions")[0].children.filter((child) => child.tagName === "button").map((button) => button.textContent),
    [COPY.editAction, COPY.sendAction, COPY.deleteAction],
    "the row's three read-only actions are back"
  );
});

// ---------------------------------------------------------------------------
// PE5: a FRESH mount renders the saved edit verbatim, under the marker
// ---------------------------------------------------------------------------
await gate("PE5", async () => {
  const edited = "Only my words now.";
  const docs = new Map([
    [CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [{ ...ENTRY, editedBody: edited }] } }]
  ]);
  const { root } = await mountExpandedRow(docs);

  // Collapsed header: the review's ORIGINAL title, plus the marker.
  const marker = byClass(root, "rv-edited");
  assert.equal(marker.length, 1, "the collapsed row carries the edited marker");
  assert.equal(textOf(marker[0]), COPY.editedMarker, "the marker reads as the pane's own copy");
  assert.equal(textOf(byClass(root, "rv-row-title")[0]), ENTRY.title, "the header keeps the review's original title");

  // Expanded body: the stored text, verbatim.
  assert.equal(byClass(root, "rv-stored").length, 1, "the expanded body is the stored text");
  assert.equal(textOf(byClass(root, "rv-stored")[0]), edited, "verbatim — not a re-derivation of the original review");
  assert.equal(byClass(root, "rv-summary").length, 0, "the derived summary is not drawn");
  assert.equal(byClass(root, "rv-issue").length, 0, "nor the original issue rows");
  assert.equal(byClass(root, "rv-editbody").length, 0, "a saved row is read-only again");

  // The row model agrees — this is the same frame's decision layer.
  const model = buildPaneModel({ entries: [{ ...ENTRY, editedBody: edited }], chatId: CHAT, expandedIds: [ENTRY.id] });
  assert.equal(model.rows[0].editedBody, edited, "the row model carries the stored body");
  assert.equal(model.rows[0].isEdited, true, "the row model reports it as edited");
  assert.equal(model.rows[0].draftBody, edited, "re-opening the state seeds the field from the STORED body, not the derived one");
});

// ---------------------------------------------------------------------------
// PE6: "Send to composer" carries framing + the EDITED body end to end
// ---------------------------------------------------------------------------
await gate("PE6", async () => {
  const edited = "My own words.\n\n1. Fix the density figure.";
  const docs = new Map([
    [CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [{ ...ENTRY, editedBody: edited }] } }]
  ]);
  const { frame, root } = await mountExpandedRow(docs);
  click(byText(byClass(root, "rv-row-actions")[0], COPY.sendAction)[0]);
  await settle();
  assert.equal(
    frame.composerTexts.at(-1),
    `${REVISION_FRAMING}\n\n${edited}`,
    "the composer receives the framing sentence plus the EDITED body, verbatim"
  );

  // And an UNEDITED review on the same pane still sends the derived body.
  const docs2 = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [ENTRY] } }]]);
  const second = await mountExpandedRow(docs2);
  click(byText(byClass(second.root, "rv-row-actions")[0], COPY.sendAction)[0]);
  await settle();
  assert.equal(
    second.frame.composerTexts.at(-1),
    `${REVISION_FRAMING}\n\n${DERIVED_BODY}`,
    "an unedited review still sends framing plus the derived body — the pre-edit behaviour"
  );
});

await gate("PE7", async () => {
  const docs = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [ENTRY] } }]]);
  const { frame, root } = await mountExpandedRow(docs);
  click(byText(root, COPY.editAction)[0]);
  await settle();
  const draft = "Keep the corrected total and explain the calculation.";
  const field = byClass(root, "rv-editbody")[0];
  field.value = draft;
  for (const handler of field.listeners.get("input") ?? []) handler({ type: "input" });

  const set = frame.msty.storage.chat.set;
  frame.msty.storage.chat.set = async () => { throw new Error("Storage unavailable"); };
  click(byText(root, COPY.saveAction)[0]);
  await settle();
  assert.equal(byClass(root, "rv-editbody")[0]?.value, draft, "a rejected write keeps the draft open");
  assert.equal(docs.get(CHAT)[STORAGE_KEY].entries[0].editedBody, null);

  frame.msty.storage.chat.set = set;
  click(byText(root, COPY.saveAction)[0]);
  await settle();
  assert.equal(docs.get(CHAT)[STORAGE_KEY].entries[0].editedBody, draft, "Save can retry without retyping");
  assert.equal(byClass(root, "rv-editbody").length, 0);
});

console.log(`Hermes Review pane edit contract checks passed (${gateCount} gates).`);
