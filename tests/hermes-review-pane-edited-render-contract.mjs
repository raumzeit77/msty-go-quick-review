// t_e01f96e1 contract: an EDITED review keeps the pane's layout.
// ---------------------------------------------------------------------------
// Since 1.3.8 a saved edit stored the user's text verbatim and the row drew it as
// ONE pre-wrapped paragraph, so the structure — the summary, the per-issue cards,
// the severity chips, the `Location:` / `Problem:` / `Correction:` lines —
// disappeared the moment a review was edited, even for a one-word edit. This
// release parses the body grammar THIS REPO WRITES (`revisionBody`) at RENDER
// time and draws its segments with the pane's own nodes.
//
//   ER1  the round trip: every body `revisionBody` generates parses into
//        segments, and re-emitting those segments reproduces the input — the
//        no-loss invariant, with a real function to compare against
//   ER2  the adversarial cases: a missing `Issues:` heading, a stray `Location:`
//        with no issue above it, an em dash in an issue title, CRLF endings, and
//        a body that is nothing but prose — none of them drops a line
//   ER3  the renderer reuses the look: an edited body that is structurally the
//        same as the review's own derived body renders a summary paragraph and
//        real `.rv-issue` cards — the SAME nodes, classes and text as the
//        unedited row, so the two are indistinguishable
//   ER4  the whole-document fallback stays: nothing parses -> one `.rv-stored`
//        paragraph of the verbatim text, exactly the pre-1.3.10 render
//   ER5  unrecognised blocks render as `.rv-stored` paragraphs, per paragraph —
//        never dropped
//   ER6  chips follow the EDITED text, the header does not: a severity changed in
//        the body repaints its chip while the row keeps the review's original
//        title/count/severity data and the `edited` marker explains the gap
//   ER7  the send path does not move: `buildRevisionPrompt` returns the framing
//        plus the STORED text byte-for-byte, and the frame's Send action carries
//        exactly that into the composer
//   ER8  only the edited branch changes, and the parse persists NOTHING: mounting
//        and expanding an edited row writes no history document
//
// The shape claims about the approved dummy are pinned by
// tests/hermes-review-pane-structure-contract.mjs (PS15); this file is behaviour.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVISION_FRAMING,
  REVISION_ISSUES_HEADING,
  REVISION_NO_ISSUES_NOTE,
  REVISION_SUMMARY_HEADING,
  buildRevisionPrompt,
  parseRevisionBody,
  revisionBody,
  revisionReview,
  revisionSegmentsText
} from "../hermes-review-extension/review-core.js";
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
// The strict frame host (the same one the pane-edit suite mounts): a DOM of
// plain objects and per-chat composite-key storage.
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
  const msty = {
    surface: {
      context: null,
      on(type, handler) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      }
    },
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

/**
 * Whitespace normalisation for the no-loss invariant: the significant (non-blank,
 * trailing-trimmed) lines of a text, in order. Blank-line runs between segments
 * are cosmetic; a LINE is content. Every content line of the input must survive
 * the parse, and this is how the round-trip gate compares.
 */
const significantLines = (text) =>
  String(text).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line !== "");

// ---------------------------------------------------------------------------
// Fixtures: three reviews, their derived bodies, and the shared driving steps.
// ---------------------------------------------------------------------------
const CHAT = "chat-a";
const STORAGE_KEY = `${HISTORY_STORAGE_KEY}:${CHAT}`;
const issue = (severity, title, location, problem, correction) => ({ severity, title, location, problem, correction });

const ENTRY_TWO = {
  id: "review-1",
  title: "Review found 2 issues",
  createdAt: "2026-09-22T10:00:00.000Z",
  messageCount: 3,
  modelLabel: "your reviewer model",
  summary: "The argument holds together, but two claims are stated more strongly than the sources support.",
  editedBody: null,
  chatId: CHAT,
  issues: [
    issue("High", "Density figure is attributed to the wrong source", "Message 4 — “42 units per hectare”", "The number is quoted from the 2019 study, but the cited study reports 28.", "Cite the 2019 figure (28/ha) or drop the number."),
    issue("Medium", "“All residents opposed” overstates the evidence", "Message 6", "The transcript reports a consultation with 11 responses, not a full survey.", "“the 11 respondents opposed”, or name the survey.")
  ]
};
const ENTRY_ZERO = {
  ...ENTRY_TWO,
  id: "review-2",
  title: "Review found no issues",
  summary: "No material issues were identified in the reviewed messages.",
  issues: []
};

const DERIVED_TWO = revisionBody(revisionReview(ENTRY_TWO));
const DERIVED_ZERO = revisionBody(revisionReview(ENTRY_ZERO));
assert.equal(DERIVED_TWO.startsWith(REVISION_SUMMARY_HEADING), true, "precondition: the derived body is the grammar this parser reads");
assert.equal(DERIVED_ZERO.includes(REVISION_NO_ISSUES_NOTE), true, "precondition: a zero-issue body carries the grammar's own placeholder");

const storedDoc = (entry) => ({ schemaVersion: 1, chatId: CHAT, entries: [entry] });

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
  const detail = byClass(root, "rv-row-detail")[0];
  assert.ok(detail, "precondition: the row's detail is in frame");
  return { frame, root, detail };
}

/**
 * What a reader SEES inside one row detail: every content node's class, its
 * severity attribute and its whole text. Two renders that agree here are
 * indistinguishable to the eye — which is the claim requirement 3 makes.
 */
const CONTENT_CLASSES = ["rv-summary", "rv-stored", "rv-issue", "rv-chip", "rv-issue-title", "rv-issue-line"];
const contentSignature = (detail) =>
  walk(detail)
    .filter((node) => CONTENT_CLASSES.some((className) => hasClass(node, className)))
    .map((node) => `${node.className}|${node.dataset?.sev ?? ""}|${textOf(node)}`);

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
// ER1: the round trip — parse then re-render reproduces the input
// ---------------------------------------------------------------------------
await gate("ER1", async () => {
  const generated = [
    ["the derived body of a two-issue review", DERIVED_TWO],
    ["the derived body of a zero-issue review", DERIVED_ZERO],
    [
      "a raw body built by revisionBody without normalisation",
      revisionBody({ summary: "Raw summary.", issues: [issue("Low", "A raw issue", "Message 1", "Because.", "Fix it.")] })
    ]
  ];
  for (const [what, body] of generated) {
    const parsed = parseRevisionBody(body);
    assert.equal(parsed.structured, true, `${what} must parse as structured`);
    assert.deepEqual(
      significantLines(revisionSegmentsText(parsed.segments)),
      significantLines(body),
      `${what}: re-emitting the segments must reproduce every line of the input`
    );
  }

  // The two-issue body's shape, segment by segment: summary, the heading marker,
  // then one issue per block.
  const two = parseRevisionBody(DERIVED_TWO).segments;
  assert.deepEqual(two.map((segment) => segment.kind), ["summary", "issues-heading", "issue", "issue"], "a two-issue body parses into summary + heading + two issues");
  assert.equal(two[0].text, ENTRY_TWO.summary, "the summary segment carries the summary text");
  assert.deepEqual(
    { severity: two[2].severity, title: two[2].title, location: two[2].location, problem: two[2].problem, correction: two[2].correction },
    ENTRY_TWO.issues[0],
    "the first issue segment reproduces the review's own fields"
  );
  assert.equal(two[2].index, 1, "the issue keeps its number");
  assert.deepEqual(
    { severity: two[3].severity, title: two[3].title, location: two[3].location, problem: two[3].problem, correction: two[3].correction },
    ENTRY_TWO.issues[1],
    "and so does the second"
  );

  // A zero-issue body: the placeholder is grammar, not prose, so it is a marker.
  const zero = parseRevisionBody(DERIVED_ZERO).segments;
  assert.deepEqual(zero.map((segment) => segment.kind), ["summary", "issues-heading", "no-issues-note"], "the zero-issue placeholder parses as a grammar marker");
  assert.deepEqual(parseRevisionBody("").segments, [], "an empty body parses into no segments at all");
  assert.equal(parseRevisionBody("").structured, false, "an empty body is not structured");
});

// ---------------------------------------------------------------------------
// ER2: the adversarial cases — no line may be dropped
// ---------------------------------------------------------------------------
await gate("ER2", async () => {
  const cases = [];

  // A. The `Issues:` heading is missing: the issue still parses and nothing is lost.
  const noHeading = `${REVISION_SUMMARY_HEADING}\nSummary of the review.\n\n1. High: Something is wrong\nLocation: Message 3\nProblem: Unsupported.\nCorrection: Cite it.`;
  const parsedNoHeading = parseRevisionBody(noHeading);
  assert.equal(parsedNoHeading.structured, true, "a body without the Issues: heading is still structured (the summary is there)");
  assert.deepEqual(parsedNoHeading.segments.map((segment) => segment.kind), ["summary", "issue"], "the issue parses without its heading");
  assert.equal(parsedNoHeading.segments[1].title, "Something is wrong", "and its fields are intact");
  cases.push(["a missing Issues: heading", noHeading, parsedNoHeading]);

  // B. A stray `Location:` with no issue above it must NOT be swallowed into a
  //    phantom issue: it stays prose.
  const stray = `${REVISION_SUMMARY_HEADING}\nSummary.\n\nLocation: nowhere in particular`;
  const parsedStray = parseRevisionBody(stray);
  assert.deepEqual(parsedStray.segments.map((segment) => segment.kind), ["summary", "prose"], "a stray Location: with no issue above it stays prose");
  assert.equal(parsedStray.segments[1].text, "Location: nowhere in particular", "and it is kept verbatim");
  cases.push(["a stray Location: line", stray, parsedStray]);

  // C. An em dash inside an issue title is title text, not a separator.
  const emDash = `${REVISION_SUMMARY_HEADING}\nS.\n\n${REVISION_ISSUES_HEADING}\n1. High: Cache — stale entries survive\nLocation: M1\nProblem: P.\nCorrection: C.`;
  const parsedEmDash = parseRevisionBody(emDash);
  assert.equal(parsedEmDash.segments[2].severity, "High", "the severity is what precedes the first colon");
  assert.equal(parsedEmDash.segments[2].title, "Cache — stale entries survive", "the em dash stays part of the title");
  cases.push(["an em dash in an issue title", emDash, parsedEmDash]);

  // D. CRLF endings parse exactly like LF.
  const lf = DERIVED_TWO;
  const crlf = lf.replace(/\n/g, "\r\n");
  const parsedCrlf = parseRevisionBody(crlf);
  assert.deepEqual(parsedCrlf, parseRevisionBody(lf), "CRLF line endings parse identically to LF");
  cases.push(["CRLF line endings", crlf, parsedCrlf]);

  // E. A body that is nothing but prose loses nothing either.
  const proseOnly = "Nothing structured here.\n\nJust two lines of the user's own words.";
  const parsedProse = parseRevisionBody(proseOnly);
  assert.equal(parsedProse.structured, false, "a prose-only body recognises no structure — the whole-document fallback applies");
  assert.deepEqual(parsedProse.segments.map((segment) => segment.kind), ["prose", "prose"], "and it is kept as prose blocks, one per paragraph");
  cases.push(["a body that is nothing but prose", proseOnly, parsedProse]);

  for (const [what, body, parsed] of cases) {
    assert.deepEqual(
      significantLines(revisionSegmentsText(parsed.segments)),
      significantLines(body),
      `${what}: no input line may be dropped — the round trip must reproduce it`
    );
    // Stronger still, and the real no-loss claim: every significant input line
    // is present, verbatim, in what the segments re-emit.
    const roundTripped = significantLines(revisionSegmentsText(parsed.segments));
    for (const line of significantLines(body)) {
      assert.ok(roundTripped.includes(line), `${what}: the line "${line}" survives the parse`);
    }
  }
});

// ---------------------------------------------------------------------------
// ER3: the renderer reuses the look — edited and unedited are indistinguishable
// ---------------------------------------------------------------------------
await gate("ER3", async () => {
  const cases = [
    ["a two-issue review", ENTRY_TWO, DERIVED_TWO],
    ["a zero-issue review", ENTRY_ZERO, DERIVED_ZERO]
  ];
  for (const [what, entry, derived] of cases) {
    const unedited = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc(entry) }]]));
    const edited = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc({ ...entry, editedBody: derived }) }]]));

    assert.deepEqual(
      contentSignature(edited.detail),
      contentSignature(unedited.detail),
      `${what}: an edited body that is structurally the same must render the SAME nodes, classes and text as the unedited row`
    );
    // ...and the unedited side really is the structured render this compares to.
    assert.equal(byClass(unedited.detail, "rv-summary").length, 1, `${what}: the unedited row renders its summary paragraph`);
    assert.equal(byClass(unedited.detail, "rv-issue").length, entry.issues.length, `${what}: the unedited row renders one card per issue`);
  }

  // The nodes are the structured path's own: a real `.rv-issue` card with its
  // outlined chip and the three labelled lines.
  const { detail } = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc({ ...ENTRY_TWO, editedBody: DERIVED_TWO }) }]]));
  const cards = byClass(detail, "rv-issue");
  assert.equal(cards.length, 2, "each recognised issue renders a real .rv-issue card");
  assert.equal(textOf(byClass(detail, "rv-summary")[0]), ENTRY_TWO.summary, "the summary segment renders in the structured path's own paragraph");
  const firstCard = cards[0];
  assert.equal(textOf(byClass(firstCard, "rv-chip")[0]), "High", "the card carries its severity chip");
  assert.equal(byClass(firstCard, "rv-chip")[0].dataset.sev, "High", "the chip carries the severity attribute the stylesheet tones on");
  assert.equal(firstCard.dataset.sev, "High", "and so does the card");
  assert.equal(textOf(byClass(firstCard, "rv-issue-title")[0]), ENTRY_TWO.issues[0].title, "the card carries the issue title");
  const lines = byClass(firstCard, "rv-issue-line").map((line) => textOf(line));
  assert.deepEqual(
    lines,
    [`Location: ${ENTRY_TWO.issues[0].location}`, ENTRY_TWO.issues[0].problem, `Correction: ${ENTRY_TWO.issues[0].correction}`],
    "the card carries the three labelled lines with the same labels the structured path writes"
  );
  assert.equal(lines.some((line) => line.startsWith("Problem:")), false, "the problem line is NOT labelled — exactly as the structured path draws it");
});

// ---------------------------------------------------------------------------
// ER4: the whole-document fallback stays
// ---------------------------------------------------------------------------
await gate("ER4", async () => {
  const prose = "My own words.\n\nStill my own words.";
  const { root, detail } = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc({ ...ENTRY_TWO, editedBody: prose }) }]]));
  const stored = byClass(detail, "rv-stored");
  assert.equal(stored.length, 1, "nothing parsed -> ONE paragraph, the pre-1.3.10 render");
  assert.equal(textOf(stored[0]), prose, "and it is the verbatim stored text, line breaks included");
  assert.equal(byClass(detail, "rv-summary").length, 0, "no summary paragraph is invented");
  assert.equal(byClass(detail, "rv-issue").length, 0, "and no issue card is invented");
  // The row is still the edited row: the marker is on the collapsed header, and
  // the read-only action row is unchanged.
  assert.equal(byClass(root, "rv-edited").length, 1, "the fallback row still carries the edited marker");
  assert.deepEqual(
    byClass(detail, "rv-row-actions")[0].children.filter((child) => child.tagName === "button").map((button) => button.textContent),
    [COPY.editAction, COPY.sendAction, COPY.deleteAction],
    "and the row's three read-only actions, exactly as before"
  );
});

// ---------------------------------------------------------------------------
// ER5: unrecognised blocks render as styled paragraphs, per paragraph
// ---------------------------------------------------------------------------
await gate("ER5", async () => {
  const mixed = `${REVISION_SUMMARY_HEADING}\nSummary line.\n\n${REVISION_ISSUES_HEADING}\n1. Low: Chipped title\nLocation: Message 2\nProblem: Still wrong.\nCorrection: Fix it.\n\nExtra note the user typed.`;
  const { detail } = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc({ ...ENTRY_TWO, editedBody: mixed }) }]]));

  assert.equal(byClass(detail, "rv-summary").length, 1, "the summary segment renders as the summary paragraph");
  assert.equal(textOf(byClass(detail, "rv-summary")[0]), "Summary line.", "with its own text");
  assert.equal(byClass(detail, "rv-issue").length, 1, "the recognised issue renders as a card");
  assert.equal(textOf(byClass(detail, "rv-chip")[0]), "Low", "with the severity the EDITED text names");
  const proseNodes = byClass(detail, "rv-stored");
  assert.equal(proseNodes.length, 1, "the unrecognised block renders as its own styled paragraph");
  assert.equal(textOf(proseNodes[0]), "Extra note the user typed.", "verbatim — never dropped, never swallowed");
  // Order: summary, then the issue card, then the prose block.
  const order = contentSignature(detail).map((entry) => entry.split("|")[0]);
  assert.equal(order[0], "rv-summary", "the summary reads first");
  assert.equal(order[1], "rv-issue", "then the issue card");
  assert.equal(order.at(-1), "rv-stored", "and the unrecognised block last");
});

// ---------------------------------------------------------------------------
// ER6: chips follow the edited text; the header does not
// ---------------------------------------------------------------------------
await gate("ER6", async () => {
  const edited = DERIVED_TWO.replace("1. High:", "1. Low:");
  const entry = { ...ENTRY_TWO, editedBody: edited };
  const { detail, root } = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc(entry) }]]));

  const chips = byClass(detail, "rv-chip").map((chip) => ({ text: textOf(chip), sev: chip.dataset.sev }));
  assert.deepEqual(chips, [{ text: "Low", sev: "Low" }, { text: "Medium", sev: "Medium" }], "the chips are drawn from what the user wrote — the text that gets sent");
  assert.equal(byClass(detail, "rv-issue")[0].dataset.sev, "Low", "the card's own severity attribute follows the edited text too");

  // The header does NOT move: it keeps the review's original data, and the
  // marker is what explains the difference.
  assert.equal(textOf(byClass(root, "rv-row-title")[0]), ENTRY_TWO.title, "the row header keeps the review's original title");
  assert.equal(byClass(root, "rv-edited").length, 1, "the edited marker is drawn on the collapsed header");

  const model = buildPaneModel({ entries: [entry], chatId: CHAT, expandedIds: [ENTRY_TWO.id] });
  assert.equal(model.rows[0].issues[0].severity, "High", "the row MODEL is untouched — editing text is not re-deriving issues");
  assert.equal(model.rows[0].issues.length, 2, "and neither is the issue count");
  assert.equal(model.rows[0].title, ENTRY_TWO.title, "the model keeps the original title");
  assert.equal(model.rows[0].isEdited, true, "while reporting the row as edited");
});

// ---------------------------------------------------------------------------
// ER7: the send path does not move
// ---------------------------------------------------------------------------
await gate("ER7", async () => {
  const edited = DERIVED_TWO.replace("28/ha", "28 per hectare");
  assert.notEqual(edited, DERIVED_TWO, "precondition: the edit really changed the body");

  assert.equal(
    buildRevisionPrompt(revisionReview(ENTRY_TWO), edited),
    `${REVISION_FRAMING}\n\n${edited}`,
    "buildRevisionPrompt returns the framing plus the STORED text, byte for byte"
  );
  assert.equal(
    buildRevisionPrompt(revisionReview(ENTRY_TWO), null),
    `${REVISION_FRAMING}\n\n${DERIVED_TWO}`,
    "an unedited review still sends framing plus the derived body"
  );
  assert.equal(
    buildRevisionPrompt(revisionReview(ENTRY_TWO), "   "),
    `${REVISION_FRAMING}\n\n${DERIVED_TWO}`,
    "a whitespace-only body is not an edit — the derived body still goes out"
  );
  assert.equal(
    buildRevisionPrompt(revisionReview(ENTRY_TWO), edited).includes("Independent review summary:"),
    true,
    "the framing is not the only thing the composer receives — the body rides with it"
  );

  // The wiring, not just the builder: the frame's Send action carries exactly it.
  const { frame, root } = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc({ ...ENTRY_TWO, editedBody: edited }) }]]));
  click(byText(byClass(root, "rv-row-actions")[0], COPY.sendAction)[0]);
  await settle();
  assert.equal(frame.composerTexts.at(-1), `${REVISION_FRAMING}\n\n${edited}`, "the composer receives framing + the edited body, verbatim");
});

// ---------------------------------------------------------------------------
// ER8: only the edited branch changes, and the parse persists nothing
// ---------------------------------------------------------------------------
await gate("ER8", async () => {
  // The unedited row renders from the structured record, never through the
  // parser: no `.rv-stored` paragraph anywhere.
  const unedited = await mountExpandedRow(new Map([[CHAT, { [STORAGE_KEY]: storedDoc(ENTRY_TWO) }]]));
  assert.equal(byClass(unedited.detail, "rv-stored").length, 0, "an unedited row renders no stored paragraph");
  assert.equal(byClass(unedited.detail, "rv-summary").length, 1, "it renders the review's own summary");
  assert.equal(byClass(unedited.detail, "rv-issue").length, ENTRY_TWO.issues.length, "and its issue cards, from the record");

  // And the parse is render-time only: mounting + expanding an edited row must
  // write NOTHING.
  const docs = new Map([[CHAT, { [STORAGE_KEY]: storedDoc({ ...ENTRY_TWO, editedBody: DERIVED_TWO }) }]]);
  const before = JSON.stringify(docs.get(CHAT)[STORAGE_KEY]);
  const { frame, detail } = await mountExpandedRow(docs);
  assert.ok(byClass(detail, "rv-issue").length === 2, "precondition: the edited row really rendered its segments");
  assert.equal(
    frame.chatWrites.filter((write) => String(write.key).startsWith("review-history:")).length,
    0,
    "rendering an edited row writes no history document — the parse is never persisted"
  );
  assert.equal(JSON.stringify(docs.get(CHAT)[STORAGE_KEY]), before, "the stored document is byte-identical after the render");
});

await gate("ER9", async () => {
  for (const label of ["Location", "Problem", "Correction"]) {
    const body = `1. High: Incorrect total\n${label}: First detail\n${label}: Second detail`;
    const parsed = parseRevisionBody(body);
    const rendered = revisionSegmentsText(parsed.segments);
    assert.ok(rendered.includes(`${label}: First detail`), "repeated labels must not overwrite the first detail");
    assert.ok(rendered.includes(`${label}: Second detail`), "the repeated detail remains visible");

    const entry = { ...ENTRY_TWO, editedBody: body };
    const docs = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries: [entry] } }]]);
    const { detail } = await mountExpandedRow(docs);
    assert.ok(textOf(detail).includes("First detail"));
    assert.ok(textOf(detail).includes("Second detail"));
  }
});

console.log(`Hermes Review pane edited render contract checks passed (${gateCount} gates).`);
