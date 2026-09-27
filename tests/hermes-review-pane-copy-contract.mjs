// t_07094a37 — pane COPY contract. Five defects the user reported after living
// with 1.3.10 in the host, all of them pane copy or pane draw:
//
//   1. an EXPANDED row still clipped its title to one ellipsised line
//      (`Conceptual comparison of Latour and ...`) although the approved dummy's
//      expanded row shows it in full — and the clipped meta line crowded the
//      timestamp beside it;
//   2. the direction field kept its text after the user pressed Enter / clicked
//      Review — a second press then re-ran the SAME instruction;
//   3. the success callout ("Review complete") had no dismiss control and could
//      not be cleared without starting another run;
//   4. signpost copy glued its ellipsis to the word before it
//      (`Reviewing recent messages...`);
//   5. the pane copy deck was not the ONE copy surface: `extension.js` carried
//      its own `Review started` literal.
//
// The mounted behaviour of 1, 2 and 3 is driven here against a real frame. The
// dummy + stylesheet half of 1 and 3 is pinned by the structure suite's PS16, and
// the deck-wide wording rule (4) and the one-surface rule (5) are gated below on
// the sources themselves. Every gate that can be mutated is: the same check runs
// against a mutated candidate and is required to FAIL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerCssImportHook } from "./helpers/css-import-hook.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "hermes-review-extension");

registerCssImportHook();
const { COPY, buildPaneModel, clampPaneTitle } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "review-pane.js")).href);
const { HISTORY_STORAGE_KEY } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "review-history.js")).href);
const { clampTitle, TRUNCATION_MARKER } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "review-core.js")).href);
const { mount } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "view.js")).href);

const viewJs = await readFile(path.join(PACKAGE_ROOT, "view.js"), "utf8");
const viewCss = await readFile(path.join(PACKAGE_ROOT, "view.css"), "utf8");

// ---------------------------------------------------------------------------
// Stylesheet reading, shared with the structure suite's vocabulary.
// ---------------------------------------------------------------------------
/** Every `selector { … }` rule of a stylesheet, in source order, comments stripped. */
function cssRules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].trim(), body: match[2] }))
    .filter((rule) => rule.selector);
}
/** Declarations of one rule body, keyed by property name. */
function declarations(body) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const chunk of String(body).split(/[;\n]/)) {
    const match = /^\s*([-a-zA-Z]+)\s*:\s*(.+)$/.exec(chunk);
    if (match) out[match[1].trim()] = match[2].trim();
  }
  return out;
}
/** The declaration maps of every rule whose selector list contains `selector`. */
const ruleBodyOf = (css, selector) =>
  cssRules(css)
    .filter((rule) => rule.selector.split(",").map((part) => part.trim()).includes(selector))
    .map((rule) => declarations(rule.body));

// ---------------------------------------------------------------------------
// The strict frame host: a DOM of plain objects, storage keyed by the ACTIVE
// chat exactly as the host's `storage.chat` is, and a way to fire the surface
// carriers the frame subscribes to.
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
  setAttribute(name, value) { this[`attr_${name}`] = String(value); }
  getAttribute(name) { return this[`attr_${name}`] ?? null; }
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
    // A readable transcript + a well-formed review: a run started in a gate can
    // really complete, so the cleared field and the completion callout are
    // asserted against the same path the host drives.
    messages: { async list() { return [{ id: "m1", role: "user", content: "PC transcript" }]; } },
    models: {
      async getStatus() { return { ready: true, configured: true, source: "assignment", modelAssignment: "reviewer" }; },
      async infer() { return { json: { title: "PC title", summary: "PC summary", issues: [] } }; }
    }
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
function click(node) {
  assert.ok(node, "the gate must find the node it clicks");
  const handlers = node.listeners?.get("click") ?? [];
  assert.ok(handlers.length > 0, `the node clicked must have a click handler (class "${node.className}")`);
  for (const handler of handlers) handler({ type: "click" });
}
const typeInto = (node, text) => {
  node.value = text;
  for (const handler of node.listeners?.get("input") ?? []) handler({ type: "input" });
};
const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const CHAT = "chat-a";
const STORAGE_KEY = `${HISTORY_STORAGE_KEY}:${CHAT}`;
/** 41 characters — stored WHOLE (the data clamp is 60), so the only thing that
 *  could have clipped it in the pane was the row's one-line CSS ellipsis. */
const LONG_TITLE = "Conceptual comparison of Latour and Callon";
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
    issues: [{ severity: "High", title: `Issue ${index}`, location: `Message ${index}`, problem: "Problem text.", correction: "Correction text." }],
    ...overrides
  };
}
const ENTRIES = [entryOf(0), entryOf(1, { title: LONG_TITLE })];

/** Mounts the tree's frame over a stored document; returns the frame + root. */
async function mountFrame(context = { chat: { id: CHAT } }, entries = []) {
  const docs = new Map([[CHAT, { [STORAGE_KEY]: { schemaVersion: 1, chatId: CHAT, entries } }]]);
  const frame = frameHost({ activeChat: CHAT, docs });
  const root = new FakeNode("div");
  new FakeDocument();
  const handle = mount({ root, msty: frame.msty, context });
  await settle();
  return { ...frame, root, handle };
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
const metaOf = (head) => head.children.find((child) => hasClass(child, "rv-row-meta")) ?? null;
const successCallout = (root) => byClass(root, "rv-callout--success")[0] ?? null;
const footerField = (root) => byClass(root, "rv-field")[0] ?? null;
const footerRunButton = (root) => byClass(root, "rv-btn--primary").find((node) => node.textContent === COPY.footerButton) ?? null;

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
// PC1: an EXPANDED row shows its title IN FULL, with its meta line ADAPTIVE
// ---------------------------------------------------------------------------
// t_9622dfc8 item A, in one place so the shipped sheet and a mutated copy are
// checked by the SAME rule. Empty when the expanded-state meta line sizes to
// its CONTENT, right-aligns itself with `margin-left: auto`, and is NOT sized to
// the full row — and when the title sizes against its own width, so the wrap
// decision follows the REAL title width (a full-row meta BASE SIZE can never
// share a line with the title: that is the empty band the user photographed).
/** @param {string} css @returns {string[]} */
function expandedMetaFindings(css) {
  const findings = [];
  const titleRules = ruleBodyOf(css, '.rv-row-head[aria-expanded="true"] .rv-row-title');
  const metaRules = ruleBodyOf(css, '.rv-row-head[aria-expanded="true"] .rv-row-meta');
  if (titleRules.length === 0) findings.push("the expanded state has no title rule");
  if (metaRules.length === 0) findings.push("the expanded state has no meta-line rule");
  for (const decl of metaRules) {
    if (/(^|\s)100%/.test(decl.flex ?? "")) findings.push(`the meta line is sized to the FULL row: flex: ${decl.flex}`);
    if (/100%/.test(decl["flex-basis"] ?? "")) findings.push(`the meta line carries flex-basis: ${decl["flex-basis"]}`);
  }
  if (!metaRules.some((decl) => (decl["margin-left"] ?? "").trim() === "auto")) {
    findings.push("the meta line does not right-align itself with margin-left: auto");
  }
  if (!metaRules.some((decl) => /(^|\s)auto$/.test((decl.flex ?? "").trim()))) {
    findings.push("the meta line is not content-sized (flex: 0 1 auto)");
  }
  if (!titleRules.some((decl) => /(^|\s)auto$/.test((decl.flex ?? "").trim()) || (decl["flex-basis"] ?? "").trim() === "auto")) {
    findings.push("the title is not sized against its own width (flex-basis: auto)");
  }
  return findings;
}

await gate("PC1", async () => {
  const { root } = await mountFrame({ chat: { id: CHAT } }, ENTRIES);
  const rows = rowsOf(root);
  assert.ok(rows.length >= 2, "the fixture's rows really painted");
  const head = headOf(rows[0]);
  const titleNode = head.children.find((child) => hasClass(child, "rv-row-title"));
  assert.ok(titleNode, "the row head carries its title node");

  // The title the pane is given is the WHOLE stored title — the elision the
  // user saw was the row's CSS, not the data.
  assert.equal(titleNode.textContent, LONG_TITLE, "the row title is the stored title, unelided");
  assert.equal(/…|\.\.\.$/.test(titleNode.textContent), false, "no marker is baked into the row's title text");

  // The state the stylesheet keys on is a REAL attribute on the head.
  assert.equal(head.getAttribute("aria-expanded"), "false", "a collapsed row states its state");
  assert.ok(metaOf(head), "the head's meta line is its own node (the marker + the timestamp)");
  assert.ok(byClass(head, "rv-row-time").length === 1, "the meta line carries the timestamp");

  click(head);
  assert.equal(headOf(rows[0]), head, "the toggle repaints the SAME head node");
  assert.equal(head.getAttribute("aria-expanded"), "true", "the toggle repaints the expanded state");
  assert.equal(titleNode.textContent, LONG_TITLE, "expanding adds no elision to the title text");
  assert.ok(rows[0].children.some((child) => hasClass(child, "rv-row-detail")), "the row really expanded");

  // …and the draw that follows that state, taken from the sheet the pane ships.
  const collapsed = ruleBodyOf(viewCss, ".rv-row-title");
  assert.ok(
    collapsed.some((decl) => decl["white-space"] === "nowrap" && decl["text-overflow"] === "ellipsis"),
    "a COLLAPSED row keeps the one-line ellipsis (the fix must not spill the list)"
  );
  assert.ok(
    ruleBodyOf(viewCss, '.rv-row-head[aria-expanded="true"] .rv-row-title').some(
      (decl) => decl["white-space"] === "normal" && decl["overflow"] === "visible" && decl["text-overflow"] === "clip"
    ),
    "an EXPANDED row's title wraps instead of clipping"
  );
  assert.ok(
    ruleBodyOf(viewCss, '.rv-row-head[aria-expanded="true"]').some((decl) => decl["flex-wrap"] === "wrap"),
    "the expanded head can wrap, so the meta line can leave the title's line when the title needs the width"
  );
  // t_9622dfc8 item A: the meta line is ADAPTIVE — content-sized and
  // right-aligned, never sized to the full row (the `flex: 1 1 100%` base size
  // is what forced the empty band under a short title).
  assert.deepEqual(
    expandedMetaFindings(viewCss),
    [],
    "an EXPANDED row's meta line must size to its content (flex: 0 1 auto) and right-align itself (margin-left: auto)"
  );
  assert.ok(
    titleNode.textContent === LONG_TITLE && head.getAttribute("aria-expanded") === "true",
    "the expansion is still driven by the real aria-expanded state on the same head node"
  );

  // …and the gate is shown to FAIL on the exact defect the card names: the
  // full-row meta rule restored.
  const fullRowMeta = viewCss.replace(
    /\.rv-row-head\[aria-expanded="true"\] \.rv-row-meta\s*\{[^}]*\}/,
    '.rv-row-head[aria-expanded="true"] .rv-row-meta { flex: 1 1 100%; justify-content: flex-end; }'
  );
  const metaFindings = expandedMetaFindings(fullRowMeta);
  assert.ok(metaFindings.length > 0, "the gate MUST fail when the expanded meta line is sized to the full row again");
  console.log(`[CTRL][PC1] full-row meta restored -> ${metaFindings[0]}`);
});

// ---------------------------------------------------------------------------
// PC2: the direction field clears when the run starts — and stays empty
// ---------------------------------------------------------------------------
await gate("PC2", async () => {
  const { root } = await mountFrame({ chat: { id: CHAT } }, ENTRIES);
  const field = footerField(root);
  const button = footerRunButton(root);
  assert.ok(field, "the footer draws its direction field");
  assert.ok(button, "the footer draws its Review action");
  assert.equal(button.disabled, false, "the action is live before the run");

  typeInto(field, "check the citations");
  click(button);

  // Synchronously after the click the run has started: the field is EMPTY (a
  // second press must not re-run the same instruction) …
  assert.equal(field.value, "", "the direction field clears the moment the run starts");
  // … and the progress panel still shows what was asked, from the run's own copy.
  const running = byClass(root, "rv-running");
  assert.equal(running.length, 1, "the running phase renders its progress panel");
  const focus = byClass(root, "rv-running-instruction")[0];
  assert.ok(focus, "the progress panel keeps the focus line after the field empties");
  assert.equal(focus.textContent, "check the citations", "the progress panel keeps what the user asked for");

  await settle();
  assert.equal(field.value, "", "the field stays empty after the run lands");
  // The run really completed (so the cleared field is not a sign of a failed
  // start), and the completion callout carries its own dismiss control.
  assert.ok(successCallout(root), "the completed run paints its success callout");
});

// ---------------------------------------------------------------------------
// PC3: the success callout dismisses — and stays dismissed
// ---------------------------------------------------------------------------
await gate("PC3", async () => {
  const completeContext = {
    chat: { id: CHAT },
    review: { phase: "complete", chatId: CHAT, completionBody: "Reviewed 4 recent messages." }
  };
  const { root, handle, fire } = await mountFrame(completeContext, ENTRIES);

  const callout = successCallout(root);
  assert.ok(callout, "a completed run paints its success callout");
  assert.equal(byClass(callout, "rv-callout-title")[0].textContent, COPY.calloutCompleteTitle, "the callout is titled from the copy table");
  const dismiss = byClass(callout, "rv-callout-dismiss")[0];
  assert.ok(dismiss, "the callout carries its own dismiss control");
  assert.equal(dismiss.textContent, COPY.calloutDismiss, "the control is a visible word, not an invisible affordance");
  assert.equal(dismiss.getAttribute("aria-label"), COPY.calloutDismissLabel, "the control carries its accessible name");

  click(dismiss);
  assert.equal(successCallout(root), null, "the dismiss clears the callout");

  // A repaint that is NOT a new run must not resurrect it.
  await handle.refresh();
  assert.equal(successCallout(root), null, "a dismissed callout does not come back on a repaint");

  // A NEW run's completion is a different event: it must show.
  fire("surface.updated", { surface: { context: { chat: { id: CHAT }, review: { phase: "running", chatId: CHAT, instruction: "" } } } });
  fire("surface.updated", { surface: { context: { chat: { id: CHAT }, review: { phase: "complete", chatId: CHAT, completionBody: "Reviewed 5 recent messages." } } } });
  await settle();
  const again = successCallout(root);
  assert.ok(again, "the next run's completion shows again — the dismiss is not permanent");
  assert.equal(byClass(again, "rv-callout-body")[0].textContent, "Reviewed 5 recent messages.", "…and it carries the NEW run's result");
});

// ---------------------------------------------------------------------------
// PC4: no signpost copy glues its ellipsis to the word before it
// ---------------------------------------------------------------------------
/** @param {Record<string, string>} deck @returns {string[]} */
function glueFindings(deck, marker) {
  const findings = [];
  for (const [key, value] of Object.entries(deck)) {
    if (typeof value !== "string") continue;
    if (/\.\.\./.test(value)) findings.push(`${key} spells its ellipsis as three dots: "${value}"`);
    else if (/[^\s]…/.test(value)) findings.push(`${key} glues its ellipsis to the word before it: "${value}"`);
  }
  if (marker !== " …") findings.push(`the shared truncation marker is ${JSON.stringify(marker)}, not " …"`);
  return findings;
}

await gate("PC4", async () => {
  assert.deepEqual(glueFindings(COPY, TRUNCATION_MARKER), [], "the copy deck's ellipsis always follows a space");

  // The two clamps share that one marker, and stay inside their limits.
  const long = "x".repeat(80);
  assert.ok(clampPaneTitle(long).endsWith(" …"), "the pane's clamp marks its truncation with a spaced ellipsis");
  assert.ok(clampTitle(long).endsWith(" …"), "the core's clamp marks its truncation with a spaced ellipsis");
  assert.equal(clampPaneTitle(long).length, 60, "the pane's clamp still honours its documented limit");
  assert.equal(/\.\.\./.test(clampTitle(long)), false, "the core's clamp never spells the marker as three dots");

  // Both halves are shown to fail.
  const gluedDeck = { ...COPY, emptyNote: "Loading..." };
  assert.ok(glueFindings(gluedDeck, TRUNCATION_MARKER).length > 0, "the gate MUST fail when a copy value glues its ellipsis");
  assert.ok(glueFindings(COPY, "...").length > 0, "the gate MUST fail when the shared marker is not the spaced ellipsis");
  console.log(`[CTRL][PC4] glue -> ${glueFindings(gluedDeck, TRUNCATION_MARKER)[0]}`);
});

// ---------------------------------------------------------------------------
// PC5: ONE copy surface — no rendered literal in view.js outside the table
// ---------------------------------------------------------------------------
/** @param {string} source @returns {string[]} */
function literalCopyFindings(source) {
  const findings = [];
  for (const match of source.matchAll(/el\(documentHost,\s*"[a-zA-Z0-9-]+",\s*"[^"]*",\s*"([^"]*)"/g)) {
    findings.push(`view.js paints the literal copy ${JSON.stringify(match[1])} straight into the tree`);
  }
  for (const match of source.matchAll(/\.(textContent|placeholder)\s*=\s*"/g)) {
    findings.push(`view.js assigns a literal to .${match[1]}`);
  }
  return findings;
}

await gate("PC5", async () => {
  assert.deepEqual(literalCopyFindings(viewJs), [], "every rendered string in view.js comes from the copy table");
  // The one string that used to live outside it — the started toast — is routed
  // through the table by the entry that shows it.
  const extensionJs = await readFile(path.join(PACKAGE_ROOT, "extension.js"), "utf8");
  assert.match(extensionJs, /COPY\.toastReviewStarted/, "the started toast reads its copy from the table");
  assert.equal(
    /"Review started"/.test(extensionJs),
    false,
    "extension.js carries no copy literal of its own — the table is the ONE surface"
  );

  const literal = `${viewJs}\nconst probe = el(documentHost, "div", "rv-x", "Hardcoded copy");\n`;
  assert.ok(literalCopyFindings(literal).length > 0, "the gate MUST fail when a literal is painted from view.js");
  console.log(`[CTRL][PC5] literal -> ${literalCopyFindings(literal)[0]}`);
});

console.log(`Hermes Review pane copy contract checks passed (${gateCount} gates).`);
