// WO016 / Card D contract: the persistent review pane's decision layer.
// Framework-free — runs review-pane.js directly with no DOM, then checks the
// manifest contribution wiring and the popup choreography in strict hosts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_DETAIL_MAX_LENGTH } from "../hermes-review-extension/review-core.js";
import { registerCssImportHook } from "./helpers/css-import-hook.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "hermes-review-extension");

const pane = await import(`${path.join(PACKAGE_ROOT, "review-pane.js").replace(/\\/g, "/")}`);
const {
  PANE_POPUP_ID,
  PANE_TITLE_BAR_ID,
  PANE_WORKSPACE_ID,
  PANE_OPEN_COMMAND,
  PANE_SHORTCUT,
  PANE_PHASES,
  PANE_CLEAR_ACTION_ID,
  COPY,
  countLine,
  severityToneOf,
  formatRowTimestamp,
  toPaneRow,
  buildPaneRows,
  buildPaneModel,
  toggleExpandedId,
  badgeText,
  deleteConfirmRequest,
  clearAllConfirmRequest,
  paneHeaderAction,
  buildPaneContext,
  parsePaneContext,
  paneToggleDecision,
  mountContextHasChat,
  mountContextChatId,
  clampPaneTitle,
  PANE_DOCUMENTED_HOST_TOKENS,
  PANE_THEME_ALIASES,
  PANE_THEME_PROBE_TOKENS,
  PANE_SCHEMES,
  THEME_REPORT_STORAGE_KEY,
  buildPaneThemeReport,
  paneSchemeFrom,
  themeReportItems,
  mergeThemeTokens,
  paneThemeStyle
} = pane;
// PD11 reads the composite storage-key prefix from the history store itself.
const { HISTORY_STORAGE_KEY } = await import(`${path.join(PACKAGE_ROOT, "review-history.js").replace(/\\/g, "/")}`);

const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "manifest.json"), "utf8"));
const viewCss = await readFile(path.join(PACKAGE_ROOT, "view.css"), "utf8");
// PD12 reads the frame's carrier registrations at the source (a plain node frame
// has no `window`, so the focus net cannot be driven here).
const viewJs = await readFile(path.join(PACKAGE_ROOT, "view.js"), "utf8");

// ---------------------------------------------------------------------------
// PD1: Copy deck (placeholder starter rows removed in t_bdf4b529), model-free
// copy, and the theme token discipline (t_0025dae6)
// ---------------------------------------------------------------------------
{
  assert.equal(COPY.panelTitle, "Quick Review");
  assert.equal(COPY.launcherLabel, "Quick Review");
  assert.equal(COPY.sendAction, "Send to composer");
  assert.equal(COPY.deleteAction, "Delete");
  assert.equal(COPY.deleteConfirmTitle, "Delete this review?");
  assert.equal(COPY.deleteConfirmBody, "This removes it from this chat. This cannot be undone.");
  assert.equal(COPY.clearAllConfirmTitle, "Clear all reviews in this chat?");
  assert.equal(COPY.toastDeleted, "Review deleted");
  assert.equal(COPY.toastAddedToComposer, "Review added to composer");
  // t_fa7ab623: the failure copy stays plain — the title is unchanged and the
  // preserved reason is introduced by a one-word label, not a jargon sentence.
  assert.equal(COPY.failureTitle, "Review failed");
  assert.equal(COPY.failureDetailLabel, "Details");
  // t_0025dae6: the empty state is a heading + one hint sentence, and the
  // failure state says plainly what happened before the load-bearing token.
  assert.equal(COPY.emptyHeading, "Review this chat");
  assert.equal(
    COPY.emptyNote,
    "Run Review to check the recent messages in this chat."
  );
  assert.equal(COPY.failureSentence, "No review came back.");
  assert.equal(COPY.footerButton, "Review");
  assert.equal(Object.isFrozen(COPY), true, "copy deck must be frozen");

  // t_0025dae6, item 4: NO pane copy names a model. Confirmed live on
  // 2026-09-22 (completion callout read "Reviewed 4 recent messages with the
  // current chat model."). Every copy value is checked, so re-introducing the
  // naming anywhere in the deck fails here; the completion body itself is
  // asserted in PD5b/PD8.
  const MODEL_NAMING = /your reviewer model|the current chat model|reviewer model|chat model/i;
  for (const [name, value] of Object.entries(COPY)) {
    assert.equal(MODEL_NAMING.test(String(value)), false, `copy ${name} must not name a model (got: ${value})`);
  }

  // t_bdf4b529: the placeholder suggestion rows are gone from the module
  // contract. Absence is asserted STRUCTURALLY (no starter/suggestion export,
  // no preset {label, instruction} row anywhere in the export surface) rather
  // than by naming the removed copy, so a re-introduction of the preset chips
  // fails this suite while the acceptance criterion "no occurrence of the
  // removed strings" stays literally true for this file.
  assert.equal(
    Object.keys(pane).some((key) => /starter|suggest/i.test(key)),
    false,
    "review-pane.js must export no starter/suggestion surface after t_bdf4b529"
  );
  for (const [name, value] of Object.entries(pane)) {
    assert.equal(
      Array.isArray(value) &&
        value.some((item) => item && typeof item === "object" && "label" in item && "instruction" in item),
      false,
      `export ${name} must not carry preset {label, instruction} suggestion rows`
    );
  }
  // ---- t_0025dae6 / t_5bffad26 theme token discipline ---------------------
  // (a) STRUCTURAL literal rule (t_5bffad26). The blanket "no literal colour
  //     anywhere in view.css" rule is what produced the weak-button bug: it
  //     forced bare `var(--foreground)` aliases, which resolve to the invalid
  //     value at computed-value time on a host that provides no token, so the
  //     declaration is dropped and a filled control renders as a transparent
  //     pill. The rule is now: no literal colour in any COMPONENT rule (a
  //     literal there would ignore the host theme); a literal is allowed only
  //     inside a `:root`-scoped alias block, as the last link of an alias
  //     chain. Comments are stripped first so prose may still name a value.
  const cssWithoutComments = viewCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const cssBlocks = [];
  for (const match of cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (selector) cssBlocks.push({ selector, body: match[2] });
  }
  const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;
  const rootBlocks = cssBlocks.filter((block) => block.selector.includes(":root"));
  const componentBlocks = cssBlocks.filter((block) => !block.selector.includes(":root"));
  assert.equal(rootBlocks.length, 2, "view.css declares the base/light alias block and the dark alias block");
  assert.ok(
    rootBlocks.some((block) => block.selector.includes('[data-rv-scheme="light"]')),
    "the light palette is declared for :root and for :root[data-rv-scheme=\"light\"]"
  );
  assert.ok(
    rootBlocks.some((block) => block.selector.includes('[data-rv-scheme="dark"]')),
    "the dark palette is declared under :root[data-rv-scheme=\"dark\"]"
  );
  for (const block of componentBlocks) {
    assert.equal(
      LITERAL_COLOUR.test(block.body),
      false,
      `component rule "${block.selector}" must not contain a literal colour (${LITERAL_COLOUR}); colours come from the --rv-* aliases`
    );
  }

  /** Declarations of one block, keyed by custom-property name. */
  const declarationsOf = (block) => {
    /** @type {Record<string,string>} */
    const out = {};
    for (const line of block.body.split("\n")) {
      const declaration = /^\s*(--rv-[a-z-]+)\s*:\s*([^;]+);/.exec(line);
      if (declaration) out[declaration[1]] = declaration[2].trim();
    }
    return out;
  };
  /** The exact `var(...)` expression an entry's chain + terminal renders to. */
  const expectedChain = (entry, terminal) => {
    let expected = terminal ?? null;
    for (const token of [...entry.chain].reverse()) expected = expected ? `var(${token}, ${expected})` : `var(${token})`;
    return expected;
  };

  const lightBlock = rootBlocks.find((block) => !block.selector.includes('[data-rv-scheme="dark"]'));
  const darkBlock = rootBlocks.find((block) => block.selector.includes('[data-rv-scheme="dark"]'));
  const lightDeclared = declarationsOf(lightBlock);
  const darkDeclared = declarationsOf(darkBlock);

  assert.equal(
    Object.keys(lightDeclared).length,
    PANE_THEME_ALIASES.length,
    "one CSS declaration per alias table entry in the light block"
  );
  assert.equal(
    Object.keys(darkDeclared).length,
    PANE_THEME_ALIASES.filter((entry) => entry.fallback).length,
    "the dark block re-declares exactly the colour aliases"
  );

  for (const entry of PANE_THEME_ALIASES) {
    // (b) The CSS value is exactly the chain the JS table declares, so the two
    //     cannot drift: `var(--a, var(--b, <terminal>))`.
    const terminal = entry.fallback ? entry.fallback.light : entry.generic;
    assert.equal(
      lightDeclared[entry.alias],
      expectedChain(entry, terminal),
      `${entry.alias} light-block CSS chain must match PANE_THEME_ALIASES`
    );
    // (c) EVERY colour alias terminates in a last-resort literal
    //     (t_5bffad26): a bare `var(--x)` colour alias is not acceptable, since
    //     it resolves to the invalid value when the host provides nothing.
    if (!entry.fallback) continue;
    // (c) EVERY colour alias terminates in a last-resort that RESOLVES to a
    //     colour with NO host at all. The light terminal is always the token's
    //     OBSERVED host value for the scheme (t_c025821b; values and provenance:
    //     tests/fixtures/host-tokens.json), written as an oklch() colour or a
    //     hex/rgb()/hsl() triple. The dark terminal is either that scheme's
    //     observed value or — where the dark half of the host snapshot has not
    //     been read yet — a documented derivation over pane aliases that do
    //     terminate in observed values (`color-mix(...)` or a bare `--rv-*`).
    //     A bare `var(--host-token)` remains unacceptable: a chain ending in an
    //     unresolved host var() drops the whole declaration.
    const OBSERVED_TERMINAL = /^(#[0-9a-fA-F]{6}|rgba?\(|hsla?\(|oklch\()/;
    const ALIAS_DERIVATION = /^(color-mix\(in oklab, var\(--rv-[a-z-]+|var\(--rv-[a-z-]+\))/;
    assert.match(
      entry.fallback.light,
      OBSERVED_TERMINAL,
      `${entry.alias} must carry the observed host value as its light fallback`
    );
    assert.ok(
      OBSERVED_TERMINAL.test(entry.fallback.dark) || ALIAS_DERIVATION.test(entry.fallback.dark),
      `${entry.alias} must carry an observed colour or an alias derivation as its dark fallback`
    );
    assert.notEqual(entry.fallback.light, entry.fallback.dark, `${entry.alias} needs a distinct dark fallback`);
    assert.equal(
      darkDeclared[entry.alias],
      expectedChain(entry, entry.fallback.dark),
      `${entry.alias} dark-block CSS chain must carry the dark literal`
    );
    assert.equal(
      new RegExp(`${entry.fallback.light.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)+$`).test(lightDeclared[entry.alias]),
      true,
      `${entry.alias} must terminate in its light literal`
    );
  }
  // (d) Every literal in the stylesheet lives in one of those alias blocks.
  const literalOwners = [];
  for (const block of rootBlocks) {
    for (const [name, value] of Object.entries(declarationsOf(block))) {
      if (LITERAL_COLOUR.test(value)) literalOwners.push(name);
    }
  }
  for (const block of componentBlocks) {
    assert.equal(LITERAL_COLOUR.test(block.body), false, `no literal colour may live in "${block.selector}"`);
  }
  assert.deepEqual(
    [...new Set(literalOwners)].sort(),
    PANE_THEME_ALIASES.filter((entry) => entry.fallback || LITERAL_COLOUR.test(String(entry.generic))).map((entry) => entry.alias).sort(),
    "every literal colour in view.css belongs to an alias-chain declaration in a :root block"
  );
  // (e) The theme API surface still resolves only host tokens; the literals are
  //     CSS-side last resorts, never values the runtime authors.
  assert.equal(
    PANE_THEME_ALIASES.some((entry) => !Array.isArray(entry.chain) || entry.chain.some((token) => !String(token).startsWith("--"))),
    false,
    "every alias chain is built from host custom properties"
  );
  // (f) The documented frame-token list stays exported as the conventions §4
  //     reference point; since t_5bffad26 a chain no longer has to terminate in
  //     one of these — it terminates in a literal, which is the rule above.
  assert.equal(PANE_DOCUMENTED_HOST_TOKENS.every((token) => String(token).startsWith("--")), true);

  // (g) The filled action paints the HOST's own primary control (t_c025821b):
  //     fill from `--primary`, label from `--primary-foreground` — the pair the
  //     official Side Chat view.css paints `.sc-primary` with. The retired
  //     "inverted ink" pair (foreground fill / background label) dated from the
  //     belief that `--primary` was a near-background grey; the frame's own
  //     published theme report shows it is the host's orange accent
  //     (oklch(0.58 0.22 35) light / oklch(0.74 0.18 47) dark). Both terminals
  //     are recorded now: the light
  //     `--primary-foreground` as oklch(0.99 0 0), while its dark counterpart is
  //     not, so the dark terminal stays a documented host-style
  //     derivation rather than a guessed literal.
  const actionFill = PANE_THEME_ALIASES.find((entry) => entry.role === "filled-action-fill");
  const actionLabel = PANE_THEME_ALIASES.find((entry) => entry.role === "filled-action-label");
  assert.deepEqual(actionFill?.chain, ["--primary"], "the filled action is the host accent");
  assert.deepEqual(actionFill?.fallback, { light: "oklch(0.58 0.22 35)", dark: "oklch(0.74 0.18 47)" }, "the action fill's last resort is the observed host accent");
  assert.deepEqual(actionLabel?.chain, ["--primary-foreground"], "the filled action's label is the host's on-accent token");
  assert.equal(actionLabel?.fallback?.light, "oklch(0.99 0 0)", "the label's light last resort is the host's observed --primary-foreground");
  assert.match(String(actionLabel?.fallback?.dark), /^color-mix\(in oklab, var\(--rv-action\), var\(--rv-bg\)/, "an unanswered on-accent token is derived host-style in dark, not authored");
  assert.ok(/\.rv-btn--primary\s*\{[^}]*background:\s*var\(--rv-action\)/.test(viewCss), "the primary button is filled from --rv-action");
  assert.ok(/\.rv-btn--primary\s*\{[^}]*color:\s*var\(--rv-action-label\)/.test(viewCss), "the primary button's label is --rv-action-label");
  // (e) Merging and resolving: a token set the host actually answers produces
  //     inline values; an unanswered alias is CLEARED so the CSS chain answers
  //     (the light→dark→light round trip must not leave the old value behind).
  const merged = mergeThemeTokens({ "--foreground": "ink", "--background": "paper" }, { "--foreground": "ink-dark" });
  assert.deepEqual(merged, { "--foreground": "ink-dark", "--background": "paper" });
  const style = paneThemeStyle({ "--primary": "accent", "--foreground": "ink", "--card": "surface" });
  assert.equal(style.set["--rv-action"], "accent");
  assert.equal(style.set["--rv-surface"], "surface");
  // A token the host does not answer falls back to the NEXT token in the chain
  // (view.css declares the same chain, so both paths agree).
  assert.equal(style.set["--rv-muted-fg"], "ink", "the muted alias falls back to its documented terminal");
  assert.equal(style.set["--rv-action-label"], undefined, "an alias the host answers with nothing is left to the CSS chain, never inlined as a literal");
  assert.ok(style.remove.includes("--rv-action-label"), "an unanswered alias is cleared, not left stale");
  assert.equal(style.set["--rv-danger"], undefined, "a tone the host does not answer is left to the CSS chain");
  const fallbackStyle = paneThemeStyle({ "--muted-foreground": "muted" });
  assert.equal(fallbackStyle.set["--rv-muted-fg"], "muted", "the first link of the chain wins when present");
  // A token set that answers nothing leaves every alias to the stylesheet chain.
  const bare = paneThemeStyle({ "--border": "line" });
  assert.deepEqual(Object.keys(bare.set), ["--rv-border"]);
  assert.deepEqual(bare.remove, PANE_THEME_ALIASES.map((entry) => entry.alias).filter((alias) => alias !== "--rv-border"));
  assert.deepEqual(paneThemeStyle({}), { set: {}, remove: PANE_THEME_ALIASES.map((entry) => entry.alias) });
  console.log("[PASS][PD1] Copy deck, model-free pane copy, and theme token discipline");
}

// ---------------------------------------------------------------------------
// PD2: Count line, badge, severity tone, timestamp formatting
// ---------------------------------------------------------------------------
{
  assert.equal(countLine(0), "0 reviews in this chat");
  assert.equal(countLine(1), "1 review in this chat");
  assert.equal(countLine(2), "2 reviews in this chat");
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(12), "12");
  assert.equal(badgeText(-3), "");
  assert.equal(badgeText(Number.NaN), "");
  assert.equal(severityToneOf("High"), "danger");
  assert.equal(severityToneOf("Medium"), "warning");
  assert.equal(severityToneOf("Low"), "info");
  assert.equal(severityToneOf(undefined), "info");
  assert.equal(severityToneOf(""), "info");
  const today = new Date();
  const formatted = formatRowTimestamp(today.toISOString());
  assert.match(formatted, /^\d{2} [A-Z][a-z]{2} \d{2}:\d{2}$/, "same-year labels are day-month + hh:mm");
  const old = formatRowTimestamp("2019-01-05T08:30:00.000Z");
  assert.match(old, /^\d{2} [A-Z][a-z]{2} 2019$/, "previous-year labels carry the year");
  assert.equal(formatRowTimestamp("not-a-date"), "");
  assert.equal(formatRowTimestamp(undefined), "");
  console.log("[PASS][PD2] Count line, badge, severity tone, timestamp formatting");
}

// ---------------------------------------------------------------------------
// PD3: Row normalization and sort model (newest first, id tiebreaker)
// ---------------------------------------------------------------------------
{
  const entry = {
    id: "review-abc",
    title: "Solid overall",
    createdAt: "2026-09-21T10:00:00.000Z",
    messageCount: 4,
    modelLabel: "your reviewer model",
    summary: "No material issues found.",
    issues: [
      { severity: "High", title: "Wrong import", location: "extension.js:12", problem: "Wrong module", correction: "Use review-core.js" },
      { severity: "Low", title: "Wording", location: "", problem: "", correction: "" }
    ]
  };
  const row = toPaneRow(entry);
  assert.equal(row.id, "review-abc");
  assert.equal(row.title, "Solid overall");
  assert.equal(row.summary, "No material issues found.");
  assert.equal(row.messageCount, 4);
  assert.equal(row.issues.length, 2);
  assert.equal(row.issues[0].tone, "danger");
  assert.equal(row.issues[1].tone, "info");
  assert.ok(row.timestampLabel.length > 0, "timestamp label renders for a valid date");

  // Degraded data never throws, falls back to the documented defaults.
  const sparse = toPaneRow({ id: "review-x", createdAt: "bogus" });
  assert.equal(sparse.title, "Review");
  assert.equal(sparse.summary, "");
  assert.deepEqual(sparse.issues, []);
  assert.equal(sparse.timestampLabel, "");
  assert.equal(toPaneRow(null), null);
  assert.equal(toPaneRow("nope"), null);
  assert.equal(toPaneRow(42), null);

  // Malformed severity values still map to a tone via the fallback chain.
  const malformed = toPaneRow({ id: "m", issues: [{ severity: 42 }, {}, "junk"] });
  assert.equal(malformed.issues.length, 3);
  assert.ok(malformed.issues.every((issue) => ["danger", "warning", "info"].includes(issue.tone)));

  // Sort: newest first, id descending as the deterministic tiebreaker.
  const rows = buildPaneRows([
    { id: "a", createdAt: "2026-09-20T08:00:00.000Z", title: "older", summary: "", issues: [] },
    { id: "c", createdAt: "2026-09-21T09:00:00.000Z", title: "newest", summary: "", issues: [] },
    { id: "b", createdAt: "2026-09-21T09:00:00.000Z", title: "tie", summary: "", issues: [] },
    { id: "d", createdAt: "nonsense", title: "undated", summary: "", issues: [] }
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["c", "b", "a", "d"]);

  // Null rows and non-array inputs are tolerated.
  assert.deepEqual(buildPaneRows([null, undefined, "junk"]), []);
  assert.deepEqual(buildPaneRows(undefined), []);
  assert.deepEqual(buildPaneRows("nope"), []);
  console.log("[PASS][PD3] Row normalization and sort model (newest first, id tiebreaker)");
}

// ---------------------------------------------------------------------------
// PD4: Full pane model (expansion filter, failure stage, chat guard)
// ---------------------------------------------------------------------------
{
  const entries = [
    { id: "r1", createdAt: "2026-09-21T10:00:00.000Z", title: "T1", summary: "s", issues: [] },
    { id: "r2", createdAt: "2026-09-20T10:00:00.000Z", title: "T2", summary: "s", issues: [] }
  ];
  const model = buildPaneModel({ entries, expandedIds: ["r2"], running: true, failureStage: "inference-request", failureDetail: "Error: provider rejected the structured response", chatId: "chat-9" });
  assert.equal(model.countLine, "2 reviews in this chat");
  assert.equal(model.hasReviews, true);
  assert.deepEqual(model.expandedIds, ["r2"]);
  assert.equal(model.running, true);
  assert.equal(model.failure.stageToken, "diagnostic-stage=inference-request");
  // t_fa7ab623: the reason rides beside the token, bounded and single-line.
  assert.equal(model.failure.detail, "Error: provider rejected the structured response");
  assert.equal(model.chatId, "chat-9");
  assert.equal(model.rows[0].id, "r1", "newest first in the render model");
  // t_0025dae6: the render model carries no model-naming copy field.
  assert.equal("reviewerLabel" in model, false, "the render model carries no model-naming field");
  // t_bdf4b529: the render model carries no starter/suggestion rows — asserted
  // by shape (no field holds preset {label, instruction} rows) so the suite
  // never re-states the removed copy.
  assert.equal("starters" in model, false, "the render model exposes no starter rows");
  assert.equal(
    Object.values(model).some(
      (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => item && typeof item === "object" && "label" in item && "instruction" in item)
    ),
    false,
    "no render-model field carries preset suggestion rows"
  );
  assert.equal(model.copy, COPY);

  // A stage without a preserved reason renders exactly as it did before: the
  // token plus `detail: null`, never an empty details line.
  const bare = buildPaneModel({ failureStage: "inference-request" });
  assert.deepEqual(bare.failure, { stageToken: "diagnostic-stage=inference-request", detail: null });
  // Overlong reasons are clamped to the shared bound; multi-line and non-string
  // values degrade to a single bounded line / null.
  const longDetail = buildPaneModel({ failureStage: "inference-request", failureDetail: "x".repeat(400) });
  assert.equal(longDetail.failure.detail.length, FAILURE_DETAIL_MAX_LENGTH);
  assert.equal(longDetail.failure.detail.endsWith("…"), true);
  assert.equal(buildPaneModel({ failureStage: "inference-request", failureDetail: "  " }).failure.detail, null);
  assert.equal(buildPaneModel({ failureStage: "inference-request", failureDetail: 42 }).failure.detail, null);

  const empty = buildPaneModel({});
  assert.equal(empty.countLine, "0 reviews in this chat");
  assert.equal(empty.hasReviews, false);
  assert.deepEqual(empty.expandedIds, []);
  assert.equal(empty.running, false);
  assert.equal(empty.failure, null);
  assert.equal(empty.chatId, null);
  assert.equal("starters" in empty, false, "the empty render model exposes no starter rows either");

  // Toggling an expanded id is idempotent per state.
  assert.deepEqual(toggleExpandedId(["a"], "a"), []);
  assert.deepEqual(toggleExpandedId(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleExpandedId(undefined, "a"), ["a"]);
  console.log("[PASS][PD4] Full pane model (expansion filter, failure stage, chat guard)");
}

// ---------------------------------------------------------------------------
// PD5: Confirm requests, title clamping, clear-all header action
// ---------------------------------------------------------------------------
{
  const del = deleteConfirmRequest();
  assert.equal(del.title, "Delete this review?");
  assert.equal(del.body, "This removes it from this chat. This cannot be undone.");
  assert.equal(del.tone, "danger");
  assert.equal(del.confirmLabel, "Delete");
  const clearAll = clearAllConfirmRequest();
  assert.equal(clearAll.title, "Clear all reviews in this chat?");
  assert.equal(clearAll.tone, "danger");

  const long = "x".repeat(80);
  assert.equal(clampPaneTitle(long).length, 60, "clamped to the documented limit (60 incl. ellipsis)");
  // t_07094a37 item 5: the ellipsis follows a SPACE, so a shortened title never
  // reads as if the marker were part of the last word.
  assert.ok(clampPaneTitle(long).endsWith(" …"));
  assert.equal(clampPaneTitle(long).endsWith("..."), false);
  assert.equal(clampPaneTitle("  short  "), "short");
  assert.equal(clampPaneTitle(undefined), "");

  // Rework t_464e32ac (conventions §6): the canonical Side Chat trash shape,
  // declared on the pane open request.
  const action = paneHeaderAction();
  assert.equal(action.id, "clear");
  assert.equal(action.label, "Clear all reviews in this chat?");
  assert.equal(action.icon, "trash");
  assert.equal(action.variant, "danger");
  assert.equal(action.disabled, false);
  assert.equal(paneHeaderAction({ disabled: true }).disabled, true);
  console.log("[PASS][PD5] Confirm requests, title clamping, clear-all header action");
}

// ---------------------------------------------------------------------------
// PD5b: Pane lifecycle context build/parse round trip (conventions §7)
// ---------------------------------------------------------------------------
{
  const running = buildPaneContext({ phase: "running", instruction: "focus on citations", chatId: "c1" });
  assert.deepEqual(running, { review: { phase: "running", instruction: "focus on citations", chatId: "c1" } });
  const parsedRunning = parsePaneContext(running);
  assert.equal(parsedRunning.phase, "running");
  assert.equal(parsedRunning.instruction, "focus on citations");

  const complete = buildPaneContext({ phase: "complete", chatId: "c1", completionBody: "Reviewed 2 recent messages." });
  assert.deepEqual(
    parsePaneContext(complete),
    { phase: "complete", chatId: "c1", instruction: null, completionBody: "Reviewed 2 recent messages.", failureStage: null, failureDetail: null }
  );

  // t_fa7ab623: a failed phase carries the preserved reason beside the token,
  // bounded on the way out (build) exactly like on the way in (parse).
  const failed = buildPaneContext({ phase: "failed", failureStage: "inference-request", failureDetail: "Error: model rejected the response format" });
  assert.deepEqual(
    parsePaneContext(failed),
    { phase: "failed", chatId: null, instruction: null, completionBody: null, failureStage: "inference-request", failureDetail: "Error: model rejected the response format" }
  );
  // A failure push with no reason stays a bare token push (no empty field).
  assert.deepEqual(
    buildPaneContext({ phase: "failed", failureStage: "inference-request" }),
    { review: { phase: "failed", failureStage: "inference-request" } }
  );
  // Run content in a reason is clamped/dropped by the shared bound: a multi-line
  // or oversized value can never reach the frame unbound.
  const clamped = buildPaneContext({ phase: "failed", failureStage: "inference-request", failureDetail: `a\nb${"x".repeat(500)}` });
  assert.equal(clamped.review.failureDetail.length, FAILURE_DETAIL_MAX_LENGTH);
  assert.equal(clamped.review.failureDetail.includes("\n"), false);
  assert.equal(buildPaneContext({ phase: "complete", failureDetail: "stale detail" }).review.failureDetail, undefined);

  // Unknown phases degrade to idle; junk payloads parse as null (not a push).
  assert.equal(buildPaneContext({ phase: "bogus" }).review.phase, "idle");
  assert.equal(parsePaneContext({}), null);
  assert.equal(parsePaneContext(null), null);
  assert.equal(parsePaneContext("junk"), null);
  assert.equal(parsePaneContext({ review: { phase: 42 } }), null);

  // PANE_PHASES is the frozen phase vocabulary shared by runner and frame.
  assert.deepEqual([...PANE_PHASES], ["idle", "running", "complete", "failed"]);
  assert.equal(Object.isFrozen(PANE_PHASES), true);
  assert.equal(PANE_CLEAR_ACTION_ID, "clear");
  console.log("[PASS][PD5b] Pane lifecycle context build/parse round trip");
}

// ---------------------------------------------------------------------------
// PD6: Toggle choreography and mount-context guard
// ---------------------------------------------------------------------------
{
  assert.deepEqual(paneToggleDecision({ paneOpen: false }, null), { action: "open" });
  assert.deepEqual(paneToggleDecision({ paneOpen: true }, { closed: true }), { action: "close" });
  assert.deepEqual(paneToggleDecision({ paneOpen: true }, { closed: false }), { action: "reopen" });
  assert.deepEqual(paneToggleDecision({ paneOpen: true }, null), { action: "close" });
  assert.deepEqual(paneToggleDecision({ paneOpen: true }, "junk"), { action: "close" });

  assert.equal(mountContextHasChat({ chat: { id: "c1" } }), true);
  assert.equal(mountContextHasChat({ chatId: "c2" }), true);
  assert.equal(mountContextHasChat({ chat: {} }), false);
  assert.equal(mountContextHasChat({}), false);
  assert.equal(mountContextHasChat(null), false);
  assert.equal(mountContextHasChat(undefined), false);
  assert.equal(mountContextHasChat("junk"), false);

  // t_61dd1e7e: the same contexts must yield the chat ID for list scoping.
  assert.equal(mountContextChatId({ chat: { id: "c1" } }), "c1");
  assert.equal(mountContextChatId({ chatId: "c2" }), "c2");
  // t_61dd1e7e (round 3): the lifecycle carrier {review:{chatId}} — the
  // runner's completion patch — must resolve too, so a future caller wiring
  // this resolver onto a lifecycle payload can never silently get null.
  assert.equal(mountContextChatId({ review: { phase: "complete", chatId: "c3" } }), "c3", "the runner's completion patch carries the active chat id");
  assert.equal(mountContextChatId({ review: { phase: "running" } }), null, "a lifecycle push without a chat id names no chat");
  assert.equal(mountContextChatId({ chat: { id: "  " } }), null, "blank ids are unknown, not scoping material");
  assert.equal(mountContextChatId({ chat: {} }), null);
  assert.equal(mountContextChatId({}), null);
  assert.equal(mountContextChatId(null), null);
  assert.equal(mountContextChatId("junk"), null);
  console.log("[PASS][PD6] Toggle choreography and mount-context guard");
}

// ---------------------------------------------------------------------------
// PD7: Manifest wiring (popup + titleBar contributions, permissions)
// ---------------------------------------------------------------------------
{
  const popupContribution = manifest.contributes?.popups?.find((p) => p?.id === PANE_POPUP_ID);
  assert.ok(popupContribution, "manifest must contribute the pane popup");
  assert.equal(popupContribution.entry, "view.js", "pane popup entry points at view.js");
  assert.equal(popupContribution.title, COPY.panelTitle);
  // t_9622dfc8 item B: the popup contribution is the DECLARED surface the pane
  // is opened by (id, no kind) — pin its command and default size so the
  // declaration cannot silently lose the fields the host reads.
  assert.equal(popupContribution.command, PANE_OPEN_COMMAND, "the pane popup is opened by the shared open command");
  assert.equal(popupContribution.size, "medium", "the pane popup declares its default size, as Side Chat's does");

  const titleBar = manifest.contributes?.titleBarItems?.find((t) => t?.id === PANE_TITLE_BAR_ID);
  assert.ok(titleBar, "manifest must contribute the title-bar launcher");
  assert.equal(titleBar.command, PANE_OPEN_COMMAND);
  assert.equal(titleBar.shortcut, PANE_SHORTCUT);

  // t_5bffad26 — the ONE-LINE invariant. The host renders a contributed item's
  // `title` and, whenever they differ, the extension `name` beneath it; Side
  // Chat reads as one line because its title and extension name are identical.
  // The `Review` / `Hermes Review` pair produced the two-line menu entry the
  // user rejected, so the invariant is asserted here for the whole display
  // surface: extension name === item title === item label.
  const menuTitle = titleBar.title;
  assert.equal(manifest.name, menuTitle, "the extension name must equal the title-bar item title (one-line menu entry)");
  assert.equal(titleBar.label, menuTitle, "the title-bar item's label must equal its title");
  assert.equal(popupContribution.title, menuTitle, "the popup title is the same host-visible name");
  assert.equal(manifest.contributes?.commands?.[0]?.label, menuTitle, "the /review command row carries the same name (it would otherwise wrap to a second line)");
  assert.equal(menuTitle, "Quick Review", "the host-visible name is Quick Review");
  assert.equal(/Hermes Review/.test(String(manifest.contributes?.modelAssignments?.[0]?.description ?? "")), false, "the reviewer assignment description must not name the retired display name");

  const popupPermission = manifest.permissions?.find((p) => p?.id === "ui.popup");
  assert.ok(popupPermission, "ui.popup permission must be declared");
  assert.equal(popupPermission.required, true, "ui.popup is required (pane is the review surface)");
  const titleBarPermission = manifest.permissions?.find((p) => p?.id === "ui.titleBar");
  assert.ok(titleBarPermission, "ui.titleBar permission must be declared");
  assert.equal(titleBarPermission.required, true);
  assert.equal(
    manifest.permissions?.some((p) => p?.id === "ui.drawer"),
    false,
    "ui.drawer must be dropped (pane replaces the drawer)"
  );
  assert.equal(typeof popupPermission.reason, "string");
  assert.ok(popupPermission.reason.length > 10, "permission reasons are human-readable");
  console.log("[PASS][PD7] Manifest wiring (popup + titleBar contributions, permissions)");
}

// ---------------------------------------------------------------------------
// PD8: Runtime popup choreography in a strict synthetic host
// ---------------------------------------------------------------------------
{
  const stored = new Map();
  const calls = { opened: [], closed: [], chromeUpdates: [], surfacePatches: [] };
  // Side Chat semantics: the open promise stays pending while the user keeps
  // the popup open and settles when the surface is dismissed.
  const openDeferreds = [];
  const msty = {
    commands: { register() { return () => {}; } },
    context: { async getCurrentChat() { return { chat: { id: "pd8" }, messages: [] }; } },
    messages: { async list() { return [{ id: "m1", role: "user", content: "PD8 transcript" }]; } },
    models: {
      async getStatus() { return { ready: true, configured: true, source: "assignment", modelAssignment: "reviewer" }; },
      async infer() { return { json: { summary: "PD8 summary", issues: [] } }; }
    },
    notifications: { async show() {} },
    composer: { async get() { return { text: "", canEdit: true }; }, async clear() {}, async setText() {} },
    storage: {
      chat: { async get(k) { return stored.get(k); }, async set(k, v) { stored.set(k, v); } },
      local: { async get(k) { return stored.get(k); }, async set(k, v) { stored.set(k, v); } }
    },
    ui: {
      registerWorkspaceItem() {},
      openContribution(request) {
        // Rework t_464e32ac: strict whitelist matching the documented
        // UiOpenContributionRequest; the open must declare the trash header
        // action and carry the runner's running-phase context. t_9622dfc8 item B:
        // the pane is opened as its DECLARED popup contribution by id, WITHOUT
        // `kind` (guide:1098-1122 — `kind` is optional when the id is unique).
        const allowed = ["id", "title", "body", "content", "closeLabel", "context", "contextSync", "headerActions"];
        const unexpected = Object.keys(request ?? {}).filter((key) => !allowed.includes(key));
        assert.deepEqual(unexpected, [], `open request undocumented fields: ${unexpected.join(", ")}`);
        assert.equal("kind" in request, false, "runtime opens the pane by its declared contribution id, without kind");
        assert.equal(request.id, PANE_POPUP_ID, "runtime opens the documented pane id");
        const actions = request.headerActions ?? [];
        assert.equal(
          actions.some((action) => action?.id === "clear" && action?.icon === "trash" && action?.variant === "danger"),
          true,
          "open request declares the canonical clear-all header action"
        );
        assert.equal(request.context?.review?.phase, "running", "open request carries the running lifecycle phase");
        calls.opened.push(request);
        return new Promise((resolve) => openDeferreds.push(resolve));
      },
      async closeSurface(request) {
        assert.equal(request.kind, "popup");
        assert.equal(request.id, PANE_POPUP_ID);
        calls.closed.push(request);
        for (const resolve of openDeferreds.splice(0)) resolve({ closed: true });
        return { closed: true };
      },
      async updateSurface(request) {
        const allowed = ["kind", "id", "title", "content", "context", "headerActions", "closeLabel"];
        const unexpected = Object.keys(request ?? {}).filter((key) => !allowed.includes(key));
        assert.deepEqual(unexpected, [], `updateSurface request undocumented fields: ${unexpected.join(", ")}`);
        assert.equal(request.kind, "popup");
        assert.equal(request.id, PANE_POPUP_ID);
        calls.surfacePatches.push(request);
        return { updated: true, id: request.id, kind: request.kind };
      },
      async update(request) { calls.chromeUpdates.push(request); }
    }
  };
  const extension = await import(`${path.join(PACKAGE_ROOT, "extension.js").replace(/\\/g, "/")}`);
  const runtime = await extension.activate(msty);

  // Open: exactly one popup open for the run command.
  await runtime.run("hermes-review.run", undefined);
  assert.equal(calls.opened.length, 1, "run auto-opens the pane exactly once");

  // Toggle: with the pane open, a second open command closes it.
  await runtime.run(PANE_OPEN_COMMAND, undefined);
  assert.equal(calls.opened.length, 1, "toggle does not open a second surface");
  assert.equal(calls.closed.length, 1, "toggle closed the open pane");

  // Lifecycle: the runner pushes completion onto the open surface (conventions
  // §7). The toggle closed that surface, so the runner must RE-OPEN it — the
  // dismissed-pane reopen rule of design §5 (r2: the sticky paneOpenAttempted
  // guard that patched a dead surface instead of re-opening is gone).
  await runtime.run("hermes-review.run", "second run");
  const completePush = calls.surfacePatches.find((patch) => patch?.context?.review?.phase === "complete");
  assert.ok(completePush, "completion is pushed to the open pane via updateSurface");
  // t_0025dae6: model-free completion copy. The 1.3.1 wording named the model
  // (confirmed verbatim in the pane on 2026-09-22, dark theme); this assertion
  // fails on it. The removed string is deliberately not restated here.
  assert.match(
    completePush.context.review.completionBody,
    /^Reviewed \d+ recent messages?\.$/,
    "completion push carries the model-free wording"
  );
  assert.equal(
    /model/i.test(completePush.context.review.completionBody),
    false,
    "completion copy must not name a model"
  );
  assert.equal(calls.opened.length, 2, "a run after the toggle closed the pane re-opens the surface (design §5 reopen)");

  // Badge update flowed through the chrome seam after persistence.
  assert.equal(calls.chromeUpdates.some((request) => request.badge === "1"), true, "launcher badge shows the stored review");
  console.log("[PASS][PD8] Runtime popup choreography in a strict synthetic host");
}

// ---------------------------------------------------------------------------
// PD9: Close-then-run re-open (r2 regression gate, reviewer round 1)
// ---------------------------------------------------------------------------
{
  // Real-host semantics: the open promise stays pending while the user keeps
  // the pane open and settles when the user dismisses it. Sequence: /review
  // (open) -> user dismisses (promise resolves) -> /review again: the pane
  // MUST open a fresh surface (design §5 auto-open/reopen). The r1 candidate
  // failed exactly here: the sticky paneOpenAttempted guard patched the dead
  // surface and never called openPaneSurface again.
  const stored = new Map();
  const calls = { opened: [], closed: [], chromeUpdates: [], surfacePatches: [] };
  const openDeferreds = [];
  const msty = {
    commands: { register() { return () => {}; } },
    context: { async getCurrentChat() { return { chat: { id: "pd9" }, messages: [] }; } },
    messages: { async list() { return [{ id: "m1", role: "user", content: "PD9 transcript" }]; } },
    models: {
      async getStatus() { return { ready: true, configured: true, source: "assignment", modelAssignment: "reviewer" }; },
      async infer() { return { json: { summary: "PD9 summary", issues: [] } }; }
    },
    notifications: { async show() {} },
    composer: { async get() { return { text: "", canEdit: true }; }, async clear() {}, async setText() {} },
    storage: {
      local: { async get(k) { return stored.get(k); }, async set(k, v) { stored.set(k, v); } },
      chat: { async get(k) { return stored.get(k); }, async set(k, v) { stored.set(k, v); } }
    },
    ui: {
      registerWorkspaceItem() {},
      openContribution(request) {
        calls.opened.push(request);
        return new Promise((resolve) => openDeferreds.push(resolve));
      },
      async closeSurface(request) {
        calls.closed.push(request);
        for (const resolve of openDeferreds.splice(0)) resolve({ closed: true });
        return { closed: true };
      },
      async updateSurface(request) { calls.surfacePatches.push(request); return { updated: true }; },
      async update(request) { calls.chromeUpdates.push(request); }
    }
  };
  const extension = await import(`${path.join(PACKAGE_ROOT, "extension.js").replace(/\\/g, "/")}`);
  const runtime = await extension.activate(msty);

  // 1. first /review opens the pane.
  await runtime.run("hermes-review.run", undefined);
  assert.equal(calls.opened.length, 1, "first /review opens the pane");
  assert.equal(calls.opened[0].context?.review?.phase, "running", "open request carries the running phase");

  // 2. the user dismisses the pane (open promise settles).
  for (const resolve of openDeferreds.splice(0)) resolve({ closed: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // 3. a second /review must RE-OPEN, not patch a dead surface.
  await runtime.run("hermes-review.run", "re-open run");
  assert.equal(calls.opened.length, 2, "a /review after dismissal re-opens the pane (design §5 auto-open)");
  assert.equal(calls.opened[1].context?.review?.phase, "running", "the re-open carries the running phase again");
  assert.equal(
    calls.opened[1].headerActions?.some((action) => action?.id === "clear" && action?.icon === "trash"),
    true,
    "the re-open request declares the clear header action again"
  );
  console.log("[PASS][PD9] Close-then-run re-open after user dismissal");
}

// ---------------------------------------------------------------------------
// PD10: manifest contribution id charset (install-time regression gate)
// ---------------------------------------------------------------------------
{
  // The Msty Go host validates contribution ids at install and rejects any
  // id outside [A-Za-z0-9_-] ("Contribution IDs may only contain letters,
  // numbers, underscores, and hyphens."). 1.3.0 shipped ids with dots
  // (hermes-review.pane / hermes-review.titlebar) and was rejected at load —
  // no runtime suite could catch that, because they test behavior, not the
  // manifest the host validates before anything runs. This gate loads the
  // real manifest.json and asserts the charset of every contribution id so
  // the class of failure is pinned shut.
  const CONTRIB_ID_COLLECTIONS = [
    "commands",
    "popups",
    "titleBarItems",
    "workspaceItems",
    "views",
    "menus",
    "modelAssignments"
  ];
  const ID_CHARSET = /^[A-Za-z0-9_-]+$/;
  const checked = [];
  for (const collection of CONTRIB_ID_COLLECTIONS) {
    const entries = manifest.contributes?.[collection];
    if (!Array.isArray(entries)) continue;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      assert.equal(typeof entry?.id, "string", `contributes.${collection}[${index}].id is a string`);
      assert.match(
        entry.id,
        ID_CHARSET,
        `contributes.${collection}[${index}].id "${entry.id}" must match [A-Za-z0-9_-] (host install-time validation)`
      );
      checked.push(`${collection}:${entry.id}`);
    }
  }
  // The gate must actually see the pane contributions, not silently pass on
  // an empty manifest (manifest.json popups + titleBarItems are mandatory).
  assert.ok(
    checked.includes(`popups:${PANE_POPUP_ID}`),
    "the popup contribution id was actually charset-checked"
  );
  assert.ok(
    checked.includes(`titleBarItems:${PANE_TITLE_BAR_ID}`),
    "the title-bar contribution id was actually charset-checked"
  );
  assert.equal(PANE_WORKSPACE_ID.match(ID_CHARSET) !== null, true, "workspace launcher id matches the charset");
  console.log(`[PASS][PD10] Manifest contribution id charset (${checked.join(", ")})`);
}

// ---------------------------------------------------------------------------
// PD11: frame-level per-chat scoping (t_61dd1e7e round 2, review finding B2's
// missing regression gate). Round 1 shipped a resolver that unit-tested green
// but was never fed a chat id by any real context shape, so both isolation
// layers failed OPEN at the frame. This gate mounts the REAL view.js frame
// and pins the actual wiring end-to-end:
// (a) the opener context {review:{phase:'running'}} resolves no chat id — the
//     frame must NOT list against a null id unless the host answers
//     getCurrentChat (fail closed);
// (b) the runner's completion push {review:{phase:'complete',chatId}} — the
//     extension's only real chat-id carrier — re-points the frame's list;
// (c) a chat-switch push {chat:{id}} re-scopes the list to the new chat;
// (d) the golden path: a foreign-attributed document renders nothing when no
//     chat id is known and the host cannot supply one.
// ---------------------------------------------------------------------------
{
  class FakeNode {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.className = ""; this.textContent = "";
      this.dataset = {}; this.listeners = new Map(); this.style = new FakeStyle();
      this.disabled = false;
      this.type = ""; this.value = ""; this.placeholder = ""; this.rows = 0;
    }
    get ownerDocument() { return FakeDocument11.instance; }
    get firstChild() { return this.children[0] ?? null; }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    setAttribute(n, v) { this[`attr_${n}`] = v; }
    addEventListener(t, h) { const l = this.listeners.get(t) ?? []; l.push(h); this.listeners.set(t, l); }
    removeEventListener() {}
  }
  // t_0025dae6: the pane writes its resolved `--rv-*` values onto the root via
  // CSSStyleDeclaration, exactly as the host's DOM does. This stub is what
  // makes "the theme switched while the pane was open" observable.
  class FakeStyle {
    constructor() { this.props = new Map(); }
    setProperty(name, value) { this.props.set(name, String(value)); }
    removeProperty(name) { this.props.delete(name); }
    getPropertyValue(name) { return this.props.get(name) ?? ""; }
  }
  Object.defineProperty(FakeNode.prototype, "classList", {
    get() { const n = this; return { add(c) { if (!n.className.includes(c)) n.className += ` ${c}`; } }; }
  });
  class FakeDocument11 {
    static instance = null;
    constructor() { FakeDocument11.instance = this; }
    createElement(t) { return new FakeNode(t); }
    createElementNS(_n, t) { return new FakeNode(t); }
  }

  /** Builds a strict frame host: per-chat composite-key storage + getCurrentChat. */
  function frameHost({ activeChat: initialChat, docs, getCurrentChat, contextEvents, themeTokens, colorScheme: initialScheme }) {
    let activeChat = initialChat;
    let tokens = themeTokens ?? {};
    let scheme = initialScheme ?? "light";
    const handlers = new Map();
    const listCalls = [];
    /** t_054750c9: the frame's `msty.events.subscribe` registration(s). */
    const eventHandlers = [];
    const surface = {
      context: null,
      on(type, handler) {
        const l = handlers.get(type) ?? [];
        l.push(handler);
        handlers.set(type, l);
        return () => {};
      }
    };
    const push = (event) => { for (const h of handlers.get("surface.updated") ?? []) h(event); };
    // t_054750c9: the catch-all surface carrier (`surface.on("*", …)`).
    const pushWildcard = (event) => { for (const h of handlers.get("*") ?? []) h(event); };
    // t_0025dae6: the host re-announces the theme on `surface.themeChanged`.
    const pushTheme = (event) => { for (const h of handlers.get("surface.themeChanged") ?? []) h(event); };
    // t_054750c9: the documented app event stream, permission `events.subscribe`.
    const emitEvent = (event) => { for (const h of eventHandlers) h(event); };
    const msty = {
      surface,
      // t_054750c9: the documented custom-UI event stream.
      events: {
        subscribe(handler) { eventHandlers.push(handler); return () => {}; }
      },
      theme: { get colorScheme() { return scheme; }, tokens: {}, getTokens: () => tokens },
      ui: { async confirm() { return { confirmed: true }; }, update() {}, async updateSurface() { return { updated: true }; } },
      notifications: { async show() {} },
      composer: { async get() { return { text: "", canEdit: true }; }, async clear() {}, async setText() {} },
      context: {
        async getCurrentChat() {
          if (contextEvents) contextEvents.push("getCurrentChat");
          return getCurrentChat ? getCurrentChat() : { chat: { id: activeChat } };
        }
      },
      storage: {
        local: { async get() { return undefined; }, async set() { throw new Error("storage.local must not be touched"); } },
        chat: {
          async get(key) {
            listCalls.push({ kind: "get", key });
            return docs.get(activeChat)?.[key];
          },
          async set(key, value) {
            listCalls.push({ kind: "set", key });
            if (!docs.has(activeChat)) docs.set(activeChat, {});
            docs.get(activeChat)[key] = value;
          }
        }
      },
      messages: { async list() { return []; } },
      models: { async getStatus() { return { ready: true, configured: true, source: "assignment" }; }, async infer() { return { json: { title: "T", summary: "s", issues: [] } }; } }
    };
    return { msty, push, pushWildcard, pushTheme, emitEvent, set themeTokens(next) { tokens = next ?? {}; }, set colorScheme(next) { scheme = next ?? "light"; }, listCalls, get activeChat() { return activeChat; }, set activeChat(id) { activeChat = id; } };
  }

  const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  const doc11 = new FakeDocument11();
  // view.js brings its stylesheet in through the module graph (t_6c564822); the
  // hook lets plain node resolve that `.css` specifier, it injects nothing.
  registerCssImportHook();
  const { mount } = await import(`${path.join(PACKAGE_ROOT, "view.js").replace(/\\/g, "/")}`);
  const makeEntry = (title, chatId) => ({ id: `review-${title}`, title, createdAt: "2026-09-22T10:00:00.000Z", messageCount: 2, modelLabel: "your reviewer model", summary: "s", chatId, issues: [] });

  // (b) lifecycle push re-points the list: the runner's completion patch is
  // the extension's only real chat-id carrier.
  {
    const docs = new Map();
    docs.set("initial-chat", { [`${HISTORY_STORAGE_KEY}:initial-chat`]: { schemaVersion: 1, chatId: "initial-chat", entries: [makeEntry("Initial chat's own review", "initial-chat")] } });
    const contextEvents = [];
    const frame = frameHost({ activeChat: "initial-chat", docs, contextEvents });
    const root = new FakeNode("div");
    const handle = mount({ root, msty: frame.msty, context: { review: { phase: "running" } } });
    await settle();
    const readsAfterMount = frame.listCalls.filter((c) => c.kind === "get").map((c) => c.key);
    assert.equal(
      readsAfterMount.length === 0 || (readsAfterMount.every((k) => k === `${HISTORY_STORAGE_KEY}:initial-chat`) && contextEvents.includes("getCurrentChat")),
      true,
      "(b) at mount with no context chat id, the frame asks the host's getCurrentChat and lists only against the id it returned (never lists against null)"
    );
    const textBefore = [];
    (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) textBefore.push(c.textContent); } })(root);
    void textBefore;
    assert.equal(
      textBefore.includes("Initial chat's own review"),
      true,
      "(b) the mount-time getCurrentChat resolution renders the current chat's own review before any push"
    );
    // The completion push carries the run's chat id — the frame consumes it.
    frame.push({ data: { context: { review: { phase: "complete", chatId: "initial-chat", completionBody: "Reviewed 2 recent messages." } } } });
    await settle();
    frame.listCalls.length = 0;
    await handle.refresh();
    const keys = frame.listCalls.filter((c) => c.kind === "get").map((c) => c.key);
    assert.ok(
      keys.includes(`${HISTORY_STORAGE_KEY}:initial-chat`),
      `(b) after the completion push the list is scoped to review-history:initial-chat (got: ${keys.join(", ") || "none"})`
    );
  }

  // (c) chat-switch push re-scopes the list to the new chat's composite key.
  // Discriminating by construction (review round 2, B1): the host's open chat
  // is MOVED to switch-chat only AFTER the frame has mounted scoped to
  // chat-a, and getCurrentChat is invoked only on refresh() fallbacks — so a
  // build whose push path never re-points state.chatId re-reads chat-a's key
  // and fails this gate, exactly like the sabotaged variant the reviewer
  // measured.
  {
    const docs = new Map();
    docs.set("chat-a", { [`${HISTORY_STORAGE_KEY}:chat-a`]: { schemaVersion: 1, chatId: "chat-a", entries: [makeEntry("Chat A's own review", "chat-a")] } });
    docs.set("switch-chat", { [`${HISTORY_STORAGE_KEY}:switch-chat`]: { schemaVersion: 1, chatId: "switch-chat", entries: [makeEntry("Switch chat's own review", "switch-chat")] } });
    const frame = frameHost({ activeChat: "chat-a", docs, getCurrentChat: () => ({ chat: { id: frame.activeChat } }) });
    const root = new FakeNode("div");
    mount({ root, msty: frame.msty, context: { review: { phase: "running" } } });
    await settle();
    const textAtMount = [];
    (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) textAtMount.push(c.textContent); } })(root);
    assert.equal(textAtMount.includes("Chat A's own review"), true, "(c) precondition: the frame is scoped to chat-a at mount");
    assert.equal(frame.listCalls.some((c) => c.kind === "get" && c.key === `${HISTORY_STORAGE_KEY}:chat-a`), true, "(c) precondition: chat-a's composite key was read at mount");
    // Now the host switches chats and pushes the new context. The frame's
    // stored id (chat-a) must be replaced, not consulted.
    frame.listCalls.length = 0;
    frame.activeChat = "switch-chat";
    frame.push({ surface: { context: { chat: { id: "switch-chat" } } } });
    await settle();
    const keys = frame.listCalls.filter((c) => c.kind === "get").map((c) => c.key);
    assert.ok(
      keys.includes(`${HISTORY_STORAGE_KEY}:switch-chat`),
      `(c) after the chat-switch push the list reads the NEW chat's composite key (got: ${keys.join(", ") || "none"})`
    );
    assert.equal(
      keys.includes(`${HISTORY_STORAGE_KEY}:chat-a`),
      false,
      "(c) the frame never reads the PREVIOUS chat's key again after a switch"
    );
    const text = [];
    (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) text.push(c.textContent); } })(root);
    assert.equal(text.includes("Chat A's own review"), false, "(c) chat A's entry is gone from the rendered list after the switch");
    assert.equal(text.includes("Switch chat's own review"), true, "(c) chat B's own entry renders after the switch");
  }

  // (e) id-less chat-change push (review round 2, B2's freshness hole): a
  // surface.updated payload that names NO chat must not leave the previous
  // chat's composite key in place. The frame must re-resolve via
  // msty.context.getCurrentChat() — the host's authoritative source — instead
  // of short-circuiting on the stored id.
  {
    const docs = new Map();
    docs.set("chat-a", { [`${HISTORY_STORAGE_KEY}:chat-a`]: { schemaVersion: 1, chatId: "chat-a", entries: [makeEntry("Chat A's own review", "chat-a")] } });
    docs.set("chat-b", { [`${HISTORY_STORAGE_KEY}:chat-b`]: { schemaVersion: 1, chatId: "chat-b", entries: [makeEntry("Chat B's own review", "chat-b")] } });
    const contextEvents = [];
    const frame = frameHost({ activeChat: "chat-a", docs, contextEvents, getCurrentChat: () => ({ chat: { id: frame.activeChat } }) });
    const root = new FakeNode("div");
    mount({ root, msty: frame.msty, context: { review: { phase: "running" } } });
    await settle();
    const textAtMount = [];
    (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) textAtMount.push(c.textContent); } })(root);
    assert.equal(textAtMount.includes("Chat A's own review"), true, "(e) precondition: the frame is scoped to chat-a at mount");
    // Chat change announced by an event that carries no chat id anywhere
    // (payload is not lifecycle, names no chat; snapshot still lags behind
    // with the opener context).
    frame.listCalls.length = 0;
    contextEvents.length = 0;
    frame.activeChat = "chat-b";
    frame.push({ surface: { context: { changed: true } } });
    await settle();
    const keys = frame.listCalls.filter((c) => c.kind === "get").map((c) => c.key);
    assert.ok(
      keys.includes(`${HISTORY_STORAGE_KEY}:chat-b`),
      `(e) after an id-less chat-change push the frame re-resolves via getCurrentChat and reads the NEW chat's key (got: ${keys.join(", ") || "none"})`
    );
    assert.equal(
      keys.includes(`${HISTORY_STORAGE_KEY}:chat-a`),
      false,
      "(e) the PREVIOUS chat's key must never be re-read after a chat change, even when the event names no chat"
    );
    assert.ok(contextEvents.includes("getCurrentChat"), "(e) the id-less push path consults the host's getCurrentChat instead of trusting the stored id");
    const text = [];
    (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) text.push(c.textContent); } })(root);
    assert.equal(text.includes("Chat A's own review"), false, "(e) chat A's entry does not render after the id-less chat change");
    assert.equal(text.includes("Chat B's own review"), true, "(e) chat B's own entry renders after the id-less chat change");
  }

  // (d) fail closed: no chat id anywhere (no context, no push, host has no
  // getCurrentChat) → the frame lists NOTHING, never a foreign document.
  {
    const docs = new Map();
    docs.set("chat-b", { [`${HISTORY_STORAGE_KEY}:chat-b`]: { schemaVersion: 1, chatId: "chat-b", entries: [makeEntry("Chat B review", "chat-b")] } });
    const frame = frameHost({ activeChat: "chat-b", docs, getCurrentChat: () => { throw new Error("context API absent on this host"); } });
    const root = new FakeNode("div");
    mount({ root, msty: frame.msty, context: { review: { phase: "running" } } });
    await settle();
    const keys = frame.listCalls.filter((c) => c.kind === "get").map((c) => c.key);
    assert.deepEqual(keys, [], "(d) with no resolvable chat id the frame issues NO history read at all (fail closed)");
    const text = [];
    (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) text.push(c.textContent); } })(root);
    assert.equal(text.includes("1 review in this chat"), false, "(d) a chat-B-attributed document renders NOTHING when the frame cannot attribute itself");
  }

  // (f) t_bdf4b529 + t_0025dae6: the empty state renders the heading and ONE
  // hint sentence — nothing else — and carries NO placeholder suggestion rows.
  // The removed starter chips were the only preset-instruction surface in the
  // frame; this pins their absence at the RENDER level (the empty container
  // holds exactly its heading and its note) while asserting the real action
  // path — footer textarea + the single primary Review button — stays
  // reachable.
  {
    const docs = new Map();
    const frame = frameHost({ activeChat: "chat-f", docs });
    const root = new FakeNode("div");
    mount({ root, msty: frame.msty, context: { chat: { id: "chat-f" } } });
    await settle();
    const nodes = [];
    (function collect(node) { for (const c of node.children) { nodes.push(c); collect(c); } })(root);
    const text = nodes.map((n) => n.textContent).filter(Boolean);
    assert.equal(text.includes("Review this chat"), true, "(f) the empty state still renders its heading");
    const classesOf = (node) => String(node.className).split(/\s+/).filter(Boolean);
    const empties = nodes.filter((n) => classesOf(n).includes("rv-empty"));
    assert.equal(empties.length, 1, "(f) exactly one empty-state container renders with an active chat");
    assert.deepEqual(
      empties[0].children.map((c) => classesOf(c)[0]),
      ["rv-empty-heading", "rv-empty-note"],
      "(f) the empty container holds its heading and its one hint sentence — no suggestion rows survive"
    );
    assert.equal(
      empties[0].children[1].textContent,
      COPY.emptyNote,
      "(f) the empty state's one hint sentence is the copy deck's emptyNote"
    );
    assert.equal(
      nodes.some((n) => classesOf(n).includes("rv-starter")),
      false,
      "(f) no starter row element is rendered anywhere in the frame"
    );
    assert.equal(
      nodes.some((n) => n.tagName === "textarea" && n.placeholder === "Optional focus or instructions"),
      true,
      "(f) the instruction field stays reachable in the empty state"
    );
    assert.equal(
      nodes.some((n) => n.tagName === "button" && n.textContent === "Review"),
      true,
      "(f) the primary Review action stays reachable in the empty state"
    );
  }

  // (f) Live theme switch (t_0025dae6, item 1). The pane must re-theme WHILE
  //     IT IS OPEN: the frame resolves the host token set on mount and again
  //     on every `surface.themeChanged`, writing the resolved `--rv-*` values
  //     onto the root. An alias the new token set does not answer is CLEARED so
  //     the stylesheet chain answers instead of a stale light value surviving a
  //     switch to dark (and the round trip back).
  {
    const docs = new Map();
    docs.set("theme-chat", { [`${HISTORY_STORAGE_KEY}:theme-chat`]: { schemaVersion: 1, chatId: "theme-chat", entries: [] } });
    const frame = frameHost({
      activeChat: "theme-chat",
      docs,
      themeTokens: { "--primary": "accent-light", "--primary-foreground": "on-accent-light", "--card": "card-light" }
    });
    const root = new FakeNode("div");
    const themeHandle = mount({ root, msty: frame.msty, context: { chat: { id: "theme-chat" } } });
    await settle();
    assert.equal(
      root.style.getPropertyValue("--rv-action"),
      "accent-light",
      "(f) mount paints the filled action from the live host accent"
    );
    assert.equal(root.style.getPropertyValue("--rv-action-label"), "on-accent-light", "(f) label from the live host on-accent token");
    assert.equal(root.style.getPropertyValue("--rv-surface"), "card-light", "(f) card alias resolved at mount");
    // t_5bffad26: the pane resolves the scheme ITSELF and stamps it on its root,
    // because a host that hands over no tokens must still get the dark palette.
    assert.equal(root.dataset.rvScheme, "light", "(f) mount stamps the resolved light scheme on the pane root");
    const storedReport = docs.get("theme-chat")[THEME_REPORT_STORAGE_KEY];
    assert.ok(storedReport, "(f) the frame publishes a theme report for /hermes_review_diagnose");
    assert.equal(storedReport.scheme, "light", "(f) the published report carries the resolved scheme");
    assert.equal(storedReport.themeChangedFired, false, "(f) no theme event has fired yet");
    assert.equal(storedReport.computed["--background"], null, "(f) a frame without getComputedStyle reports no computed value");
    assert.equal(storedReport.tokens["--primary"], "accent-light", "(f) the host token payload the frame saw is in the report");

    // Host switches to dark and re-announces, answering only `--primary`.
    // Aliases the new set does not answer must be CLEARED, never left at their
    // light value (the stale-theme bug this pins shut).
    frame.colorScheme = "dark";
    frame.themeTokens = { "--primary": "accent-dark" };
    frame.pushTheme({ data: { theme: { colorScheme: "dark", tokens: frame.msty.theme.getTokens() } } });
    assert.equal(
      root.style.getPropertyValue("--rv-action"),
      "accent-dark",
      "(f) an ALREADY-OPEN pane re-themes on surface.themeChanged (no remount)"
    );
    assert.equal(root.dataset.rvScheme, "dark", "(f) the scheme stamp follows the host to dark");
    assert.equal(
      root.style.getPropertyValue("--rv-surface"),
      "",
      "(f) an alias the new token set does not answer is cleared, never left stale"
    );
    assert.equal(
      root.style.getPropertyValue("--rv-action-label"),
      "",
      "(f) the cleared label falls back to the stylesheet chain, not to a stale value"
    );
    const darkReport = docs.get("theme-chat")[THEME_REPORT_STORAGE_KEY];
    assert.equal(darkReport.scheme, "dark", "(f) the report records the dark scheme the pane resolved");
    assert.equal(darkReport.hostScheme, "dark", "(f) the report records the host's own colorScheme");
    assert.equal(darkReport.themeChangedFired, true, "(f) the report records that surface.themeChanged fired");
    assert.equal(themeHandle.themeReport().scheme, "dark", "(f) the exposed report agrees with what was published");

    // Back to light: the round trip must land on the light values again.
    frame.colorScheme = "light";
    frame.themeTokens = { "--primary": "accent-light", "--primary-foreground": "on-accent-light", "--card": "card-light" };
    frame.pushTheme({ data: { theme: { colorScheme: "light", tokens: frame.msty.theme.getTokens() } } });
    assert.equal(root.style.getPropertyValue("--rv-action"), "accent-light", "(f) dark→light round trip re-themes");
    assert.equal(root.style.getPropertyValue("--rv-surface"), "card-light", "(f) the cleared alias comes back");
    assert.equal(root.dataset.rvScheme, "light", "(f) the scheme stamp returns to light with no stale dark value");

    // A payload that carries the tokens itself is honoured (payload-first, as
    // on the context path) even when the host's getter has nothing.
    frame.themeTokens = {};
    frame.pushTheme({
      data: { theme: { colorScheme: "dark", tokens: { "--primary": "accent-from-payload", "--primary-foreground": "label-from-payload" } } }
    });
    assert.equal(
      root.style.getPropertyValue("--rv-action"),
      "accent-from-payload",
      "(f) a themeChanged payload's own token set is honoured"
    );
    assert.equal(root.style.getPropertyValue("--rv-action-label"), "label-from-payload", "(f) payload label applied");
  }

  // (g) Row spacing (t_0025dae6, item 3): finished reviews are SIBLING cards
  //     with a real gap, never nested under one shared border. Checked with
  //     THREE rows and mixed collapse state — the host run of 2026-09-22 had a
  //     single review, so a sibling pair could not be observed there.
  {
    const docs = new Map();
    const entries = [
      makeEntry("Row one", "rows-chat"),
      makeEntry("Row two", "rows-chat"),
      makeEntry("Row three", "rows-chat")
    ];
    entries[0].createdAt = "2026-09-22T10:00:00.000Z";
    entries[1].createdAt = "2026-09-21T10:00:00.000Z";
    entries[2].createdAt = "2026-09-20T10:00:00.000Z";
    docs.set("rows-chat", { [`${HISTORY_STORAGE_KEY}:rows-chat`]: { schemaVersion: 1, chatId: "rows-chat", entries } });
    const frame = frameHost({ activeChat: "rows-chat", docs });
    const root = new FakeNode("div");
    mount({ root, msty: frame.msty, context: { chat: { id: "rows-chat" } } });
    await settle();

    const collectByClass = (node, cls, out = []) => {
      for (const child of node.children ?? []) {
        if (String(child.className ?? "").split(/\s+/).includes(cls)) out.push(child);
        collectByClass(child, cls, out);
      }
      return out;
    };
    const rowsOf = () => {
      const lists = collectByClass(root, "rv-list");
      assert.equal(lists.length, 1, "(g) the review rows live in exactly one list container");
      return lists[0].children.filter((child) => String(child.className).includes("rv-row"));
    };

    const rows = rowsOf();
    assert.equal(rows.length, 3, "(g) three review rows render as siblings");
    assert.equal(
      rows.some((row) => collectByClass(row, "rv-row").length > 0),
      false,
      "(g) no review row nests inside another (the pre-fix shape shared one border)"
    );

    // Mixed collapse state: expand the middle row through its own head.
    const head = rows[1].children.find((child) => String(child.className).includes("rv-row-head"));
    assert.ok(head, "(g) each row has a collapse/expand head");
    for (const handler of head.listeners.get("click") ?? []) handler();
    const afterToggle = rowsOf();
    assert.equal(afterToggle.length, 3, "(g) expanding one row keeps all three rows");
    assert.equal(
      afterToggle[1].children.some((child) => String(child.className).includes("rv-row-detail")),
      true,
      "(g) the clicked row is expanded"
    );
    assert.equal(
      afterToggle[0].children.some((child) => String(child.className).includes("rv-row-detail")) ||
        afterToggle[2].children.some((child) => String(child.className).includes("rv-row-detail")),
      false,
      "(g) the sibling rows stay collapsed"
    );

    // The gap is real CSS on the list, and every card owns its border/radius.
    assert.ok(/\.rv-list\s*\{[^}]*gap:\s*[1-9]/.test(viewCss), "(g) the list declares a real gap between rows");
    assert.ok(
      /\.rv-row\s*\{[^}]*border:\s*1px solid var\(--rv-border\)/.test(viewCss),
      "(g) each row is its own bordered card"
    );
    assert.ok(/\.rv-row\s*\{[^}]*border-radius/.test(viewCss), "(g) each row is its own rounded card");
    assert.equal(/\.rv-row\s*\{[^}]*border-top/.test(viewCss), false, "(g) rows must not share a single top border");
  }

  // (h) t_5bffad26: the theme-report helpers the diagnostic depends on. Pure,
  //     total, and never throwing on junk input.
  {
    assert.deepEqual(PANE_SCHEMES, ["light", "dark"]);
    assert.equal(paneSchemeFrom("dark"), "dark");
    assert.equal(paneSchemeFrom("DARK"), "dark");
    assert.equal(paneSchemeFrom(undefined, null, "light"), "light");
    assert.equal(paneSchemeFrom("nonsense"), "light", "an unknown scheme falls back to light");
    assert.equal(paneSchemeFrom(42, {}), "light");
    assert.equal(PANE_THEME_PROBE_TOKENS.includes("--primary"), true, "the probe reports the host's --primary");

    const report = buildPaneThemeReport({
      scheme: "dark",
      hostScheme: "dark",
      themeChangedFired: true,
      computed: { "--background": "rgb(20, 22, 26)", "--nope": "junk" },
      tokens: { "--foreground": "#f0f1f3" },
      at: "2026-09-22T20:00:00.000Z"
    });
    assert.equal(report.scheme, "dark");
    assert.equal(report.hostScheme, "dark");
    assert.equal(report.themeChangedFired, true);
    assert.equal(report.computed["--background"], "rgb(20, 22, 26)");
    assert.equal(report.computed["--foreground"], null, "a token the frame did not compute reads as null");
    assert.equal("--nope" in report.computed, false, "only the documented probe tokens are reported");
    assert.equal(report.tokens["--foreground"], "#f0f1f3");
    assert.deepEqual(buildPaneThemeReport("junk"), {
      scheme: "light",
      hostScheme: null,
      themeChangedFired: false,
      computed: Object.fromEntries(PANE_THEME_PROBE_TOKENS.map((name) => [name, null])),
      tokens: Object.fromEntries(PANE_THEME_PROBE_TOKENS.map((name) => [name, null])),
      rendered: null,
      // t_054750c9: a report with no intake evidence reports the empty shape,
      // never a missing field — the reader may index it unconditionally.
      contextSync: { hostEvents: 0, carriers: [], eventTypes: [], rescopes: 0, chatIds: [], foreignPushes: 0 },
      at: null
    });

    const items = themeReportItems(report);
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item.value]));
    assert.equal(byLabel["pane data-rv-scheme"], "dark");
    assert.equal(byLabel["surface.themeChanged fired"], "yes");
    assert.equal(byLabel["computed --background"], "rgb(20, 22, 26)");
    assert.equal(byLabel["computed --card"], "(absent)");
    assert.equal(byLabel["theme.getTokens() --foreground"], "#f0f1f3");
    assert.equal(byLabel["theme.getTokens() --border"], "(absent)");
    assert.equal(themeReportItems(null).length, 1, "an unreadable report renders one readable row");
    assert.equal(themeReportItems(null)[0].value, "(unreadable report)");
  }

  // -------------------------------------------------------------------------
  // PD12: switching chats with the pane OPEN re-scopes it (t_054750c9 — the
  // user's report, verbatim: "while the pane is kept open and I switch chats,
  // the pane isn't updated with the reviews of the chat that is now open").
  //
  // The installed host decides which channel announces a chat switch, and that
  // is not knowable offline, so the frame subscribes to all of them: the named
  // `surface.updated` payload, the catch-all surface event, and the documented
  // `msty.events.subscribe` stream. Each is driven here — a build that listens
  // on none of them re-reads the previous chat's composite key and fails.
  // -------------------------------------------------------------------------
  {
    const docs = new Map();
    docs.set("chat-a", { [`${HISTORY_STORAGE_KEY}:chat-a`]: { schemaVersion: 1, chatId: "chat-a", entries: [makeEntry("Chat A's own review", "chat-a")] } });
    docs.set("chat-b", { [`${HISTORY_STORAGE_KEY}:chat-b`]: { schemaVersion: 1, chatId: "chat-b", entries: [makeEntry("Chat B's own review", "chat-b")] } });
    const frame = frameHost({ activeChat: "chat-a", docs, getCurrentChat: () => ({ chat: { id: frame.activeChat } }) });
    const root = new FakeNode("div");
    const handle = mount({ root, msty: frame.msty, context: { review: { phase: "running", instruction: "focus" } } });
    await settle();
    const frameText = () => {
      const out = [];
      (function collect(node) { for (const c of node.children) { if (c.children.length) collect(c); if (c.textContent) out.push(c.textContent); } })(root);
      return out;
    };
    const readKeys = () => frame.listCalls.filter((call) => call.kind === "get").map((call) => call.key);

    // Preconditions: the pane is scoped to chat A and shows A's own review, and
    // the auto-open progress it was handed is rendered (the initial adoption of
    // a chat scope must NOT wipe the lifecycle chrome the runner just pushed).
    assert.equal(frameText().includes("Chat A's own review"), true, "(PD12) precondition: the pane is scoped to chat A at mount");
    assert.equal(frameText().includes(COPY.running), true, "(PD12) precondition: the mount-scoped running phase renders");

    // (1) The chat switch: the host moves its open chat to B and announces it.
    frame.listCalls.length = 0;
    frame.activeChat = "chat-b";
    frame.push({ surface: { context: { chat: { id: "chat-b" } } } });
    await settle();
    assert.equal(frameText().includes("Chat B's own review"), true, "(PD12) the newly opened chat's own reviews render after the switch");
    assert.equal(frameText().includes("Chat A's own review"), false, "(PD12) the previous chat's review is gone from the pane after the switch");
    assert.equal(frameText().includes(COPY.running), false, "(PD12) the previous chat's running progress must not keep hijacking the new chat's pane");
    assert.deepEqual(
      [...new Set(readKeys())],
      [`${HISTORY_STORAGE_KEY}:chat-b`],
      "(PD12) after the switch the frame reads ONLY the new chat's composite key"
    );

    // (2) A LATE push for the chat the pane just left. It is the outcome of a
    // run that belongs to chat A: its completion text must not appear in B's
    // pane, and B's own rows must stay untouched.
    frame.push({ data: { context: { review: { phase: "complete", chatId: "chat-a", completionBody: "Reviewed 2 recent messages." } } } });
    await settle();
    assert.equal(frameText().includes("Review complete"), false, "(PD12) a late completion push for the previous chat paints nothing in the new chat's pane");
    assert.equal(frameText().includes("Chat A's own review"), false, "(PD12) the late push does not resurrect the previous chat's rows");
    assert.equal(frameText().includes("Chat B's own review"), true, "(PD12) the new chat's rows survive the late push untouched");

    // (3) …including a late RUNNING push: the other chat's progress must not
    // replace this chat's pane either.
    frame.push({ data: { context: { review: { phase: "running", chatId: "chat-a", instruction: "focus" } } } });
    await settle();
    assert.equal(frameText().includes(COPY.running), false, "(PD12) another chat's running phase does not hijack the pane");
    assert.equal(frameText().includes("Chat B's own review"), true, "(PD12) the pane still shows its own chat after the foreign running push");

    // (4) A chat with NO reviews renders its OWN empty state — and it arrives on
    // the documented app event stream (permission `events.subscribe`), the
    // carrier a custom UI is told to use for exactly this.
    frame.activeChat = "chat-c";
    frame.emitEvent({ type: "chats.activeChanged", data: { chat: { id: "chat-c" } } });
    await settle();
    assert.equal(frameText().includes("Chat B's own review"), false, "(PD12) the previous chat's rows are gone after a switch announced on the event stream");
    assert.equal(frameText().includes(COPY.emptyHeading), true, "(PD12) a chat with no reviews renders its own empty state");
    assert.equal(frameText().includes(COPY.running), false, "(PD12) the event-stream switch leaves no stale lifecycle chrome");

    // (5) Switching BACK shows the first chat's reviews again — the state is not
    // one-way. This one arrives on the catch-all surface carrier.
    frame.activeChat = "chat-a";
    frame.pushWildcard({ type: "surface.contextChanged", surface: { context: { chat: { id: "chat-a" } } } });
    await settle();
    assert.equal(frameText().includes("Chat A's own review"), true, "(PD12) switching back renders the first chat's reviews again");
    assert.equal(frameText().includes(COPY.emptyHeading), false, "(PD12) the empty state of the chat in between does not survive the switch back");

    // (6) The instrument: one open now says which carrier fired, how often, and
    // where the chat scope moved — the read-back that answers the native
    // question without a screenshot.
    const report = handle.themeReport();
    const sync = report.contextSync;
    assert.ok(sync.hostEvents >= 5, `(PD12) the report counts the host-context deliveries it received (got ${sync.hostEvents})`);
    for (const carrier of ["surface.updated", "surface.*", "events.subscribe"]) {
      assert.ok(sync.carriers.includes(carrier), `(PD12) the report names the ${carrier} carrier (got: ${sync.carriers.join(", ")})`);
    }
    assert.equal(sync.foreignPushes, 2, "(PD12) the report counts the two foreign pushes it dropped");
    assert.equal(sync.rescopes, 4, "(PD12) the report counts the chat-scope adoptions");
    assert.deepEqual(sync.chatIds, ["chat-a", "chat-b", "chat-c", "chat-a"], "(PD12) the report records the chat id resolved at each re-scope");
    assert.ok(sync.eventTypes.includes("chats.activeChanged"), "(PD12) the report keeps the host's own event vocabulary");
    // The same evidence is left where /hermes_review_diagnose reads it: the
    // frame publishes its report into the chat-scoped storage it already uses.
    const published = docs.get("chat-a")?.[THEME_REPORT_STORAGE_KEY];
    assert.ok(published, "(PD12) the frame publishes its report for the diagnose path");
    assert.equal(published.contextSync.rescopes, 4, "(PD12) the published report carries the re-scope evidence");

    // (7) The last net, asserted at the source (a plain node frame has no
    // window): the pane also re-checks the scope when it regains focus, so a
    // host that announces nothing still cannot leave a stale chat on screen.
    assert.match(viewJs, /addEventListener\(\s*"focus"/, "(PD12) the pane re-checks the active chat on focus");
    assert.match(viewJs, /msty\.events\.subscribe/, "(PD12) the pane subscribes to the documented event stream");
    assert.match(viewJs, /msty\.surface\.on\(\s*"\*"/, "(PD12) the pane subscribes to the catch-all surface event");
  }

  console.log("[PASS][PD11] Frame-level per-chat scoping (lifecycle push + chat switch re-point the list, unknown chats fail closed, empty state renders heading + hint with no placeholder rows) and the t_0025dae6 pane frame behaviour (live theme switch, sibling row cards)");
  console.log("[PASS][PD12] Chat switch with the pane open re-scopes it (all three host carriers, no cross-chat leakage in either direction, own empty state per chat, and the intake instrument the native read-back reads)");
}

console.log("Hermes Review pane contract checks passed (12 gates).");
