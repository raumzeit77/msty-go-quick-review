// @ts-check
// Framework-free decision logic for the persistent review pane (view.js / 
// extension.js consume it; tests call it directly without any DOM). Every
// user-visible decision — list model, copy strings, formatting, collapse
// state, confirm requests, popup ids, toggle choreography — lives here so the
// DOM glue stays thin and the suites never need a browser environment.

import { boundFailureDetail, revisionBody, revisionReview, REVISION_FRAMING, TITLE_MAX_LENGTH, TRUNCATION_MARKER } from "./review-core.js";

/** Stable popup surface id shared by the manifest contribution and the runtime. */
export const PANE_POPUP_ID = "hermes-review-pane";
/** Stable title-bar contribution id. */
export const PANE_TITLE_BAR_ID = "hermes-review-titlebar";
/** Stable workspace launcher id (re-pointed, still optional chrome). */
export const PANE_WORKSPACE_ID = "hermes-review-workspace";
/** Runtime command every pane opener delivers to run(). */
export const PANE_OPEN_COMMAND = "hermes-review.openPane";
/** Modifier+key shortcut for the title-bar launcher. */
export const PANE_SHORTCUT = "mod+shift+r";

/** Exact copy deck (design contract §4). Tests assert these verbatim. */
export const COPY = Object.freeze({
  /**
   * Host-visible surface name. The project is *Hermes Review*; the name the
   * host shows for this extension is *Quick Review* (t_5bffad26). Keep it
   * byte-identical to `manifest.name` and to the title-bar contribution's
   * `title`, or the host renders an item title with the extension name
   * underneath it — the two-line menu entry the user rejected.
   */
  panelTitle: "Quick Review",
  launcherLabel: "Quick Review",
  launcherTooltip: "Open the review panel",
  emptyHeading: "Review this chat",
  /**
   * The empty state is a heading, this one hint sentence, and nothing else
   * (t_0025dae6). No starter/placeholder rows: the footer field + `Review`
   * button and `/review` are the only new-review controls.
   *
   * t_07094a37, the copy audit: the sentence used to describe the mechanism
   * ("An independent pass over the recent messages — findings land here with
   * their location and a correction"). The rule for this deck is that a string
   * either informs or instructs; that one did neither, so it says what to DO
   * instead, in one line.
   */
  emptyNote: "Run Review to check the recent messages in this chat.",
  footerPlaceholder: "Optional focus or instructions",
  footerButton: "Review",
  /**
   * The footer action's label while the last run failed (t_6c564822). The dummy
   * (design reference, state 4) places the retry where the
   * primary action sits — the footer — and draws no second button inside the
   * failure callout, so the pane re-labels its ONE action instead of adding one.
   */
  retryAction: "Retry",
  /**
   * A `word …` never glues its ellipsis to the word (t_07094a37, item 5): the
   * user's screenshot read `Reviewing recent messages...`, and the same
   * convention is applied wherever an ellipsis follows a word (the title clamp
   * and the failure-detail bound share `TRUNCATION_MARKER`).
   */
  running: "Reviewing recent messages …",
  failureTitle: "Review failed",
  /**
   * One plain sentence in front of the load-bearing `diagnostic-stage=` token
   * (t_0025dae6). It carries the failure REASON and names no model, which is
   * what the deck's model-free rule requires; the run's provenance lives in the
   * stored history entry's `modelLabel`, which is never rendered.
   *
   * t_07094a37, the copy audit: the sentence used to talk about the inference
   * step ("The model didn't return a review."). The reason it carries is simply
   * that no review came back, so it says that and leaves the mechanism out.
   */
  failureSentence: "No review came back.",
  /**
   * The success callout (t_07094a37). Its title used to be a hardcoded literal
   * in `view.js`; it lives here now, because this table is the pane's ONE copy
   * surface. `calloutDismiss` is the visible word on the small control that
   * clears the callout, and `calloutDismissLabel` is that control's accessible
   * name — an affordance the user can SEE: a dismiss that hides behind a
   * click-anywhere-on-the-callout is no affordance at all.
   */
  calloutCompleteTitle: "Review complete",
  calloutDismiss: "Dismiss",
  calloutDismissLabel: "Dismiss this notice",
  /**
   * The no-active-chat state (t_07094a37). Both strings were hardcoded in
   * `view.js`; the header hint is the short form and the empty state's note is
   * the one line that says what to do about it.
   */
  noChatHeading: "No active chat",
  noChatNote: "No active chat — open a conversation first.",
  /**
   * Label prefix for the bounded reason line under the failure stage token
   * (t_fa7ab623). The token stays the load-bearing surface; the reason is a
   * secondary prose line, never a replacement for it.
   */
  failureDetailLabel: "Details",
  sendAction: "Send to composer",
  deleteAction: "Delete",
  /**
   * Editing one review's text in place (t_db84b23e, design §9 state 5). The way
   * in is the item's OWN action row — a real word-button, first among that
   * row's actions — and the edit state carries Cancel (ghost, left) then
   * Save (primary, right). `editFramingLabel` is the dummy's `.k` line: it says
   * out loud which part of the prompt the user cannot edit.
   */
  editAction: "Edit",
  saveAction: "Save",
  cancelAction: "Cancel",
  editFramingLabel: "Sent above your text, unchanged",
  /** Accessible name for the editable field (the dummy's `aria-label`). */
  editFieldLabel: "Review body",
  /** The marker on an edited entry's collapsed row (design §9, variant A). */
  editedMarker: "edited",
  deleteConfirmTitle: "Delete this review?",
  deleteConfirmBody: "This removes it from this chat. This cannot be undone.",
  clearAllConfirmTitle: "Clear all reviews in this chat?",
  toastReviewStarted: "Review started",
  toastReviewComplete: "Review complete",
  toastReviewFailed: "Review failed",
  toastAddedToComposer: "Review added to composer",
  toastDeleted: "Review deleted"
});

/** @param {unknown} value @returns {any} */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** @param {unknown} value */
function asNonBlankString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Count line per the copy deck: singular when exactly one review.
 * @param {number} count
 */
export function countLine(count) {
  return count === 1 ? "1 review in this chat" : `${count} reviews in this chat`;
}

/** @param {unknown} value */
export function severityToneOf(value) {
  const severity = asNonBlankString(value) ?? "";
  if (severity === "High") return "danger";
  if (severity === "Medium") return "warning";
  return "info";
}

/** @param {Date} date */
function twoDigit(date) {
  return String(date.getDate()).padStart(2, "0");
}

/**
 * Compact timestamp for a stored review row: `21 Sep 20:14`, or the four-digit
 * year for anything from a previous calendar year.
 * @param {unknown} isoTimestamp
 */
export function formatRowTimestamp(isoTimestamp) {
  const time = typeof isoTimestamp === "string" ? Date.parse(isoTimestamp) : Number.NaN;
  if (Number.isNaN(time)) return "";
  const date = new Date(time);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayMonth = `${twoDigit(date)} ${months[date.getMonth()]}`;
  if (date.getFullYear() !== new Date().getFullYear()) {
    return `${dayMonth} ${date.getFullYear()}`;
  }
  return `${dayMonth} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** @param {unknown} value */
function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalizes one stored history entry (schema v1) into a pane row model.
 * Returns null only for values that cannot be rendered at all.
 * @param {unknown} entry
 */
export function toPaneRow(entry) {
  const record = asObject(entry);
  if (!record) return null;
  const issues = Array.isArray(record.issues) ? record.issues : [];
  const editedBody = asNonBlankString(record.editedBody);
  return {
    id: asNonBlankString(record.id) ?? "",
    title: asNonBlankString(record.title) ?? "Review",
    createdAt: asNonBlankString(record.createdAt) ?? "",
    timestampLabel: formatRowTimestamp(record.createdAt),
    summary: asNonBlankString(record.summary) ?? "",
    messageCount: asFiniteNumber(record.messageCount),
    modelLabel: asNonBlankString(record.modelLabel) ?? "",
    /**
     * The user's edited body, or null when this review has never been edited
     * (t_db84b23e). When it is set the row renders THIS text verbatim — never
     * the parsed issue rows — and "Send to composer" sends it.
     */
    editedBody,
    /** Whether the row carries the "edited" marker in its collapsed header. */
    isEdited: editedBody !== null,
    issues: issues
      .map((/** @type {unknown} */ issue) => {
        const issueRecord = asObject(issue) ?? {};
        const severity = asNonBlankString(issueRecord.severity) ?? "Medium";
        return {
          severity,
          tone: severityToneOf(severity),
          title: asNonBlankString(issueRecord.title) ?? "Review issue",
          location: asNonBlankString(issueRecord.location) ?? "",
          problem: asNonBlankString(issueRecord.problem) ?? "",
          correction: asNonBlankString(issueRecord.correction) ?? ""
        };
      })
  };
}

/**
 * Builds the pane's list model from a freshly read history document read
 * newest-first (or any entry order — the model always re-sorts by createdAt
 * descending, id descending as the tiebreaker).
 * @param {unknown[]} entries
 */
export function buildPaneRows(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((/** @type {unknown} */ entry) => toPaneRow(entry))
    .filter(Boolean);
  rows.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    if (nb !== na) return nb - na;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return rows;
}

/**
 * Full static render model: everything view.js needs to paint one frame of
 * the pane without making its own decisions.
 *
 * `editingId` is the one row currently in its edit state (t_db84b23e), or null.
 * Every row carries the two things that state needs: `draftBody` — the field's
 * INITIAL value, i.e. the stored edited body when there is one and the derived
 * body when there is not (both built through the same `review-core.js`
 * normalization the composer path uses, so the text the user sees is exactly
 * the text that would be sent) — and `editing`, whether this row is the open
 * one. `framing` is the constant paragraph the field must NOT contain.
 *
 * @param {{entries?: unknown[], expandedIds?: string[], running?: boolean, instruction?: string, failureStage?: string|null, failureDetail?: string|null, chatId?: unknown, editingId?: unknown}} payload
 */
export function buildPaneModel(payload = {}) {
  const rows = buildPaneRows(payload.entries ?? []);
  const expanded = new Set(Array.isArray(payload.expandedIds) ? payload.expandedIds : []);
  const failureStage = asNonBlankString(payload.failureStage) ?? null;
  const chatId = asNonBlankString(payload.chatId);
  const editingId = asNonBlankString(payload.editingId);
  return {
    rows: rows.filter(Boolean).map((row) => ({
      ...row,
      draftBody: row.editedBody ?? revisionBody(revisionReview(row)),
      editing: editingId !== null && row.id === editingId
    })),
    countLine: countLine(rows.length),
    hasReviews: rows.length > 0,
    expandedIds: rows.filter((row) => expanded.has(row.id)).map((row) => row.id),
    running: payload.running === true,
    instruction: asNonBlankString(payload.instruction) ?? "",
    editingId,
    /**
     * The constant framing sentence the pane draws ABOVE the editable field
     * (design §9 state 5). It is `review-core.js`'s own export, never a copy:
     * the pane can neither drift from the prompt nor let an edit reach it.
     */
    framing: REVISION_FRAMING,
    failure: failureStage
      ? {
        stageToken: `diagnostic-stage=${failureStage}`,
        // Bounded secondary reason (t_fa7ab623): null when the push carried
        // no detail, so the callout renders exactly as it did before.
        detail: boundFailureDetail(payload.failureDetail)
      }
      : null,
    chatId,
    copy: COPY
  };
}

/** @param {string} id @returns {string} new expanded-id list with `id` toggled */
export function toggleExpandedId(ids, id) {
  const current = new Set(Array.isArray(ids) ? ids : []);
  if (current.has(id)) current.delete(id);
  else current.add(id);
  return [...current];
}

/** Badge text: the review count as a very short string, empty when zero. */
export function badgeText(count) {
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? String(count) : "";
}

/**
 * Confirmation requests. Kept here so the exact copy is testable.
 */
export function deleteConfirmRequest() {
  return { title: COPY.deleteConfirmTitle, body: COPY.deleteConfirmBody, tone: "danger", confirmLabel: COPY.deleteAction };
}

export function clearAllConfirmRequest() {
  return { title: COPY.clearAllConfirmTitle, tone: "danger", confirmLabel: COPY.deleteAction };
}

/**
 * Popup-toggle choreography decision (extension side). Mirrors Side Chat:
 * with the pane open, a second invocation closes it; `closed: false` from the
 * host means the host lost the popup, so the guard resets and reopens.
 * @param {{paneOpen: boolean}} state @param {unknown} closeResult
 * @returns {{action: "close"|"reopen"|"open"}}
 */
export function paneToggleDecision(state, closeResult) {
  if (!state?.paneOpen) return { action: "open" };
  const record = asObject(closeResult);
  return { action: record && record.closed === false ? "reopen" : "close" };
}

/** Mount context check: when the frame has no chat, complain, never silently. */
export function mountContextHasChat(context) {
  const record = asObject(context);
  if (!record) return false;
  const chat = asObject(record.chat);
  return Boolean(chat?.id ?? asNonBlankString(record.chatId));
}

/**
 * Extracts the active chat id from a mount/surface context payload: either
 * `{ chat: { id } }` (host contextSync shape), a flat `{ chatId }`, or the
 * lifecycle carrier `{ review: { chatId } }` (the runner's completion patch —
 * the same shape absorbRunnerContext reads via parsePaneContext). Handles the
 * lifecycle shape so a future caller wiring this resolver onto a lifecycle
 * payload cannot silently get null. Returns null when the context names no
 * chat.
 * @param {unknown} context
 */
export function mountContextChatId(context) {
  const record = asObject(context);
  if (!record) return null;
  const chat = asObject(record.chat);
  return asNonBlankString(chat?.id) ?? asNonBlankString(record.chatId)
    ?? asNonBlankString(asObject(record.review)?.chatId);
}

/** Clamp helper re-exported so view.js and tests share one limit. */
export function clampPaneTitle(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`
    : trimmed;
}

// ---------------------------------------------------------------------------
// Pane lifecycle context (conventions §7): the runner opens the pane with a
// progress context and patches it at each stage; view.js renders
// running/completion/failure from the pushed context. The whole payload lives
// under one `review` key so the frame can distinguish a lifecycle push from
// any other context (e.g. a chat switch carrying active-chat data).
// ---------------------------------------------------------------------------

/** Lifecycle phase names pushed from the runner to the pane frame. */
export const PANE_PHASES = Object.freeze(["idle", "running", "complete", "failed"]);

/** Canonical trash header action (conventions §6, Side Chat's shape). */
export const PANE_CLEAR_ACTION_ID = "clear";

/**
 * Builds the canonical clear-all header action for a headerActions[] list.
 * @param {{disabled?: boolean}} [options]
 */
export function paneHeaderAction(options = {}) {
  const action = {
    id: PANE_CLEAR_ACTION_ID,
    label: COPY.clearAllConfirmTitle,
    icon: "trash",
    variant: "danger",
    disabled: options.disabled === true
  };
  return action;
}

/**
 * Full context payload for a pane open/patch request at a given phase.
 * `completionBody` is the callout body (1.3.1 wording); `failureDetail` is the
 * bounded reason that rides beside the failure stage token (t_fa7ab623); an
 * absent field renders as a plain absent field, never an empty string.
 * @param {{phase: string, chatId?: unknown, instruction?: unknown, completionBody?: unknown, failureStage?: unknown, failureDetail?: unknown}} payload
 */
export function buildPaneContext(payload) {
  const phase = PANE_PHASES.includes(payload?.phase) ? payload.phase : "idle";
  /** @type {Record<string, unknown>} */
  const review = {
    phase,
    chatId: asNonBlankString(payload?.chatId) ?? undefined,
    instruction: asNonBlankString(payload?.instruction) ?? undefined,
    completionBody: asNonBlankString(payload?.completionBody) ?? undefined,
    failureStage: asNonBlankString(payload?.failureStage) ?? undefined,
    // Only a `failed` push can carry a reason: a completed or running phase
    // never surfaces a stale detail line.
    failureDetail: phase === "failed" ? boundFailureDetail(payload?.failureDetail) ?? undefined : undefined
  };
  for (const key of ["chatId", "instruction", "completionBody", "failureStage", "failureDetail"]) {
    if (review[key] === undefined) delete review[key];
  }
  return { review };
}

/**
 * Parses a lifecycle review context off a context payload (open context or a
 * pushed surface context). Returns null when the payload carries no `review`
 * lifecycle record — the signature the runner pushes; anything else (unknown
 * shapes, no chat) means "not a lifecycle push" and the frame ignores it.
 * @param {unknown} context
 */
export function parsePaneContext(context) {
  const record = asObject(context);
  const review = asObject(record?.review);
  if (!review) return null;
  const phase = PANE_PHASES.includes(review.phase) ? review.phase : null;
  if (!phase) return null;
  return {
    phase,
    chatId: asNonBlankString(review.chatId),
    instruction: asNonBlankString(review.instruction),
    completionBody: asNonBlankString(review.completionBody),
    failureStage: asNonBlankString(review.failureStage),
    failureDetail: asNonBlankString(review.failureDetail)
  };
}

// ---------------------------------------------------------------------------
// Theme adaptation (t_0025dae6). The user's requirement: "when Msty Go changes
// to dark theme and vice versa, our UI needs to change as well."
//
// The pane adapts on two independent paths, and the pane suite asserts both:
//
// 1. CSS (`view.css`): every component rule paints through a `--rv-*` alias
//    whose value is a host-token fallback chain, so the pane follows the host
//    theme with no JavaScript at all.
// 2. Runtime (`view.js`): the frame reads the live token set on mount and on
//    every `surface.themeChanged` event and writes the resolved values onto
//    the pane root, so adaptation holds even on a host that does not re-apply
//    variables to an already-mounted frame.
//
// Values applied at runtime are the host's own token values (or nothing at
// all, leaving the CSS chain to answer). No colour is ever authored here.
// ---------------------------------------------------------------------------

/**
 * Host tokens this host version documents as frame-provided (source:
 * the Msty extension authoring guide §4, citing guide:1183-1186). Kept as
 * documentation of the *documented* set. Since t_c025821b an alias chain
 * prefers the host token and terminates in one of two documented answers:
 * a **recorded host value** for that scheme (the values this project pins in its
 * offline harness — see the pane design reference, "Colours") or a **host-style derivation**
 * (`color-mix(in oklab, …)`) when the host is not known to provide
 * the token. Neither terminates in another bare `var()`: an unresolvable chain
 * resolves to the *invalid* value at computed-value time and the declaration is
 * dropped, which is how the pane's one filled control once rendered as a weak
 * transparent pill.
 */
export const PANE_DOCUMENTED_HOST_TOKENS = Object.freeze([
  "--background",
  "--foreground",
  "--primary",
  "--border",
  "--font-sans",
  "--extension-success",
  "--extension-warning"
]);

/**
 * The `--rv-*` alias table, one entry per alias declared in `view.css`.
 *
 * `chain` is the host-token fallback chain in precedence order. The terminal is
 * one of:
 *
 *  * `fallback` — the token's **observed host value** for the scheme
 *    (2026-09-22, read from the pane's own published frame theme report; the
 *    same values, with their provenance, live in `tests/fixtures/host-tokens.json`).
 *    A colour alias declared this way is re-declared in the
 *    `:root[data-rv-scheme="dark"]` block; it is the last resort that keeps a
 *    declaration from being dropped, and it is the host's own colour rather
 *    than a colour authored here.
 *  * `generic` — a scheme-independent terminal: a length/time/easing/font stack,
 *    or a `color-mix(in oklab, …)` derivation for a token the host has never
 *    reported. A derivation is built only from aliases that already have an
 *    observed terminal, so it can never be the link that goes unresolvable.
 *
 * The stylesheet declares the same chains under `:root, :root[data-rv-scheme="light"]`
 * and `:root[data-rv-scheme="dark"]`; the pane suite builds the expected
 * `var(...)` expression from `chain` + terminal and asserts byte agreement with
 * both blocks, and the host-native suite resolves these declarations against the
 * fixture and asserts the action's colours really come from the host accent.
 *
 * No component rule carries a literal colour, and no alias is left without a
 * terminal — `tests/hermes-review-pane-contract.mjs` and
 * `tests/hermes-review-pane-fidelity-contract.mjs` both pin that.
 */
export const PANE_THEME_ALIASES = Object.freeze([
  { alias: "--rv-font", chain: ["--font-sans"], generic: "\"Inter\", ui-sans-serif, system-ui, -apple-system, sans-serif" },
  { alias: "--rv-mono", chain: ["--font-mono"], generic: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { alias: "--rv-radius", chain: ["--radius"], generic: "14px" },
  { alias: "--rv-radius-sm", chain: [], generic: "max(6px, calc(var(--rv-radius) - 3px))" },
  { alias: "--rv-dur", chain: [], generic: "160ms" },
  { alias: "--rv-ease", chain: [], generic: "cubic-bezier(0.22, 1, 0.36, 1)" },
  { alias: "--rv-action-shadow", chain: ["--button-shadow"], generic: "0 1px 2px oklch(0 0 0 / 0.08), 0 5px 18px color-mix(in oklch, var(--rv-action) 9%, transparent)", role: "action-shadow" },
  // observed host values (light / dark) — the pane's whole colour vocabulary
  { alias: "--rv-bg", chain: ["--background"], fallback: { light: "oklch(0.975 0.008 255)", dark: "oklch(0.145 0.028 264)" } },
  { alias: "--rv-fg", chain: ["--foreground"], fallback: { light: "oklch(0.23 0.032 264)", dark: "oklch(0.95 0.009 250)" } },
  { alias: "--rv-muted-fg", chain: ["--muted-foreground", "--foreground"], fallback: { light: "oklch(0.47 0.03 260)", dark: "oklch(0.72 0.025 255)" } },
  { alias: "--rv-border", chain: ["--border"], fallback: { light: "oklch(0.86 0.022 255 / 0.74)", dark: "oklch(0.31 0.035 262 / 0.72)" } },
  { alias: "--rv-surface", chain: ["--card"], fallback: { light: "oklch(0.995 0.003 255 / 0.82)", dark: "oklch(0.195 0.032 262 / 0.82)" } },
  // preferences for tokens the host reported in the light snapshot only: the
  // light terminal is that observed value, the dark terminal is a documented
  // derivation over aliases that do have an observed terminal (the dark half of
  // the snapshot is still being extracted — see the fixture's darkHalfPending).
  { alias: "--rv-raised", chain: ["--input", "--secondary", "--muted"], fallback: { light: "oklch(0.91 0.018 255 / 0.90)", dark: "color-mix(in oklab, var(--rv-bg), var(--rv-fg) 5%)" } },
  { alias: "--rv-ring", chain: ["--ring"], fallback: { light: "oklch(0.58 0.22 35)", dark: "color-mix(in oklab, var(--rv-action), var(--rv-bg) 35%)" } },
  // severity tones: the host's own extension palette (observed light), degrading
  // to the observed foreground when the host hides the tone.
  { alias: "--rv-danger", chain: ["--extension-danger"], fallback: { light: "oklch(0.58 0.21 25)", dark: "var(--rv-fg)" } },
  { alias: "--rv-warning", chain: ["--extension-warning"], fallback: { light: "oklch(0.65 0.16 78)", dark: "var(--rv-fg)" } },
  { alias: "--rv-info", chain: ["--extension-info"], fallback: { light: "oklch(0.57 0.16 242)", dark: "var(--rv-fg)" } },
  { alias: "--rv-success", chain: ["--extension-success"], fallback: { light: "oklch(0.56 0.16 157)", dark: "var(--rv-fg)" } },
  // The filled action (the footer's one `Review` button) follows the host's own
  // primary control, which is what makes the pane read as native: fill from
  // `--primary`, label from `--primary-foreground` — the pair the official Side
  // Chat paints `.sc-primary` with. The earlier "inverted ink" pair is retired:
  // it was chosen when `--primary` was believed to be a near-background grey,
  // and the frame's own report shows the opposite (an orange accent,
  // `oklch(0.58 0.22 35)` light / `oklch(0.74 0.18 47)` dark).
  //
  // The label token is the host's own light value (`oklch(0.99 0 0)`); its dark
  // counterpart is not known, so the dark terminal is the host-style
  // derivation (`color-mix(in oklab, …)` of the fill and the background, a
  // near-background shade tinted 8% toward the accent) rather than a guess at a
  // dark literal. The host-native suite resolves and contrast-checks both
  // schemes, with a host answering and with a host silent.
  { alias: "--rv-action", chain: ["--primary"], fallback: { light: "oklch(0.58 0.22 35)", dark: "oklch(0.74 0.18 47)" }, role: "filled-action-fill" },
  { alias: "--rv-action-label", chain: ["--primary-foreground"], fallback: { light: "oklch(0.99 0 0)", dark: "color-mix(in oklab, var(--rv-action), var(--rv-bg) 92%)" }, role: "filled-action-label" }
]);

/** The two colour schemes the pane resolves for itself and stamps on its root. */
export const PANE_SCHEMES = Object.freeze(["light", "dark"]);

/**
 * The host tokens `/hermes_review_diagnose` reports per source (frame report
 * and runtime probe) — the tokens the pane's look actually turns on.
 *
 * `--primary-foreground` joined the set in t_c025821b: it is the one link in
 * the filled action's chain this host has never reported, so a native run is
 * what settles whether the frame exposes it at all (the pane answers with a
 * `color-mix` derivation when it does not, and the host-native suite proves that
 * branch offline). The other seven are the colours and font the look is built
 * from, `--primary` first among them because it now paints the one action.
 */
export const PANE_THEME_PROBE_TOKENS = Object.freeze([
  "--background",
  "--foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--card",
  "--muted-foreground",
  "--font-sans"
]);

/**
 * `storage.chat` key the pane frame writes its theme report under
 * (t_5bffad26). The frame is the only place the live theme is visible — the
 * runtime has no DOM and no theme API — so `/hermes_review_diagnose` reads
 * this read-only. The key deliberately shares no prefix with the history store
 * (`HISTORY_STORAGE_KEY`), which only ever reads its own composite key.
 */
export const THEME_REPORT_STORAGE_KEY = "pane-theme-report";

/**
 * The pane's own marker custom property (t_6c564822). `view.css` declares it as
 * a `:root`-scoped alias of the host's `--primary`, so its COMPUTED value on the
 * frame's root is the single cheapest answer to "did the host apply our
 * stylesheet at all?" — a pane whose sheet never arrived leaves it empty. The
 * frame reports it; nothing reads it to paint.
 */
export const ACTION_MARKER_TOKEN = "--rv-action";

/**
 * Resolves a colour scheme from any number of candidate host values, in
 * precedence order. Anything that is not the exact string `light` or `dark`
 * (case-insensitively) is ignored; when the host reports nothing the scheme
 * falls back to `light`.
 * @param {...unknown} candidates
 * @returns {"light"|"dark"}
 */
export function paneSchemeFrom(...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    if (value === "dark" || value === "light") return value;
  }
  return "light";
}

/**
 * Normalizes the pane frame's theme observation into the report the diagnostic
 * reads (t_5bffad26), including what the frame actually RENDERED (t_6c564822):
 * the sheets present in the frame document, the marker property's computed
 * value, and the computed box of the pane's one primary action. Purely
 * presentational data — token names, class names and computed values, never
 * model or provider identifiers, never a colour authored here.
 * @param {{scheme?: unknown, hostScheme?: unknown, themeChangedFired?: unknown, computed?: unknown, tokens?: unknown, at?: unknown, rendered?: unknown, contextSync?: unknown}} payload
 */
export function buildPaneThemeReport(payload = {}) {
  const computedSource = asObject(payload.computed) ?? {};
  const tokenSource = asObject(payload.tokens) ?? {};
  /** @type {Record<string, string|null>} */
  const computed = {};
  /** @type {Record<string, string|null>} */
  const tokens = {};
  for (const name of PANE_THEME_PROBE_TOKENS) {
    computed[name] = asNonBlankString(computedSource[name]) ?? null;
    tokens[name] = asNonBlankString(tokenSource[name]) ?? null;
  }
  const hostScheme = typeof payload.hostScheme === "string" && PANE_SCHEMES.includes(payload.hostScheme.trim().toLowerCase())
    ? payload.hostScheme.trim().toLowerCase()
    : null;
  return {
    scheme: paneSchemeFrom(payload.scheme, hostScheme),
    hostScheme,
    themeChangedFired: payload.themeChangedFired === true,
    computed,
    tokens,
    rendered: normalizeRendered(payload.rendered),
    // What the frame's host-context intake saw (t_054750c9) — the evidence that
    // makes "does the host tell an open pane about a chat switch, and through
    // which channel" a fact one pane open can answer.
    contextSync: normalizeContextSync(payload.contextSync),
    at: asNonBlankString(payload.at) ?? null
  };
}

/**
 * Bounds what the frame may report about its host-context intake (t_054750c9):
 * how many deliveries arrived on the subscribed carriers, which carriers they
 * were, the host's own event type names seen, and how the pane's chat scope
 * moved. Names and ids only — never a message, a transcript or a token.
 * @param {unknown} value
 */
export function normalizeContextSync(value) {
  const record = asObject(value);
  if (!record) return { hostEvents: 0, carriers: [], eventTypes: [], rescopes: 0, chatIds: [], foreignPushes: 0 };
  /** @param {unknown} input @param {number} limit @returns {Array<string|null>} */
  const names = (input, limit) => {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    for (const item of list) {
      if (out.length >= limit) break;
      // A nullish chat id is meaningful (a scope the pane could not resolve)
      // and is kept as null; blank or non-string junk is dropped.
      if (item === null || item === undefined) out.push(null);
      else {
        const text = asNonBlankString(item);
        if (text) out.push(text);
      }
    }
    return out;
  };
  /** @param {unknown} input @returns {number} */
  const count = (input) => {
    const value = Number(input);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  return {
    hostEvents: count(record.hostEvents),
    carriers: names(record.carriers, 8).filter((name) => typeof name === "string"),
    eventTypes: names(record.eventTypes, 12).filter((name) => typeof name === "string"),
    rescopes: count(record.rescopes),
    chatIds: names(record.chatIds, 12),
    foreignPushes: count(record.foreignPushes)
  };
}

/** One measured box, as two rounded numbers — or null when unmeasurable.
 * @param {unknown} value */
function asBox(value) {
  const record = asObject(value);
  if (!record) return null;
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Bounds what the frame may report about the DOM it rendered (t_6c564822). The
 * frame reads these values; nothing here is authored, and an unrecognized or
 * malformed field is dropped rather than passed through — the report is
 * diagnostic evidence, so its shape must be predictable to a reader.
 * @param {unknown} value
 */
export function normalizeRendered(value) {
  const record = asObject(value);
  if (!record) return null;
  const sheets = Array.isArray(record.styleSheets) ? record.styleSheets : [];
  const styleSheets = sheets.slice(0, 8).map((/** @type {unknown} */ sheet) => {
    const entry = asObject(sheet) ?? {};
    const rules = Number(entry.rules);
    return {
      href: asNonBlankString(entry.href) ?? "(inline)",
      owner: asNonBlankString(entry.owner),
      rules: Number.isFinite(rules) ? rules : null,
      unreadable: entry.unreadable === true
    };
  });
  const actionSource = asObject(record.action);
  const action = actionSource
    ? {
        className: typeof actionSource.className === "string" ? actionSource.className : "",
        backgroundColor: asNonBlankString(actionSource.backgroundColor),
        color: asNonBlankString(actionSource.color),
        borderRadius: asNonBlankString(actionSource.borderRadius),
        boxShadow: asNonBlankString(actionSource.boxShadow),
        padding: asNonBlankString(actionSource.padding),
        fontSize: asNonBlankString(actionSource.fontSize)
      }
    : null;
  return {
    styleSheets,
    marker: asNonBlankString(record.marker),
    action,
    actionBox: asBox(record.actionBox),
    rootBox: asBox(record.rootBox)
  };
}

/**
 * Renders one pane theme report as diagnostic `kv` items: what the host
 * reported, what the pane resolved, and each probe token per source
 * (present value or `(absent)`). Never throws on a malformed report.
 * @param {unknown} report
 * @returns {Array<{label: string, value: string}>}
 */
export function themeReportItems(report) {
  const record = asObject(report);
  if (!record) {
    return [{ label: "pane frame report", value: "(unreadable report)" }];
  }
  const computed = asObject(record.computed) ?? {};
  const tokens = asObject(record.tokens) ?? {};
  const items = [
    { label: "host colorScheme", value: asNonBlankString(record.hostScheme) ?? "(unreported)" },
    { label: "pane data-rv-scheme", value: asNonBlankString(record.scheme) ?? "(unresolved)" },
    { label: "surface.themeChanged fired", value: record.themeChangedFired === true ? "yes" : "no" },
    { label: "reported at", value: asNonBlankString(record.at) ?? "(unreported)" }
  ];
  for (const name of PANE_THEME_PROBE_TOKENS) {
    items.push({ label: `computed ${name}`, value: asNonBlankString(computed[name]) ?? "(absent)" });
  }
  for (const name of PANE_THEME_PROBE_TOKENS) {
    items.push({ label: `theme.getTokens() ${name}`, value: asNonBlankString(tokens[name]) ?? "(absent)" });
  }
  // What the frame actually rendered (t_6c564822): the sheets the frame document
  // holds, the marker property, and the computed action. This is what makes
  // "did the host apply our stylesheet?" a fact instead of a debate.
  const rendered = asObject(record.rendered);
  if (rendered) {
    const sheets = Array.isArray(rendered.styleSheets) ? rendered.styleSheets : [];
    items.push({ label: "frame styleSheets", value: sheets.length === 0 ? "(none)" : String(sheets.length) });
    for (const [index, sheet] of sheets.entries()) {
      const entry = asObject(sheet) ?? {};
      const rules = entry.rules === null || entry.rules === undefined ? "?" : String(entry.rules);
      const unreadable = entry.unreadable === true ? " unreadable" : "";
      items.push({
        label: `sheet ${index + 1}`,
        value: `${asNonBlankString(entry.owner) ?? "(unknown owner)"} ${asNonBlankString(entry.href) ?? "(inline)"} rules=${rules}${unreadable}`
      });
    }
    items.push({ label: `computed ${ACTION_MARKER_TOKEN} (marker)`, value: asNonBlankString(rendered.marker) ?? "(absent)" });
    const action = asObject(rendered.action);
    if (action) {
      items.push({ label: "action className", value: asNonBlankString(action.className) ?? "(none)" });
      for (const field of ["backgroundColor", "color", "borderRadius", "boxShadow", "padding", "fontSize"]) {
        items.push({ label: `action ${field}`, value: asNonBlankString(action[field]) ?? "(absent)" });
      }
    }
    const box = (/** @type {unknown} */ value) => {
      const entry = asObject(value);
      return entry ? `${entry.width}×${entry.height}` : "(unmeasured)";
    };
    items.push({ label: "action box", value: box(rendered.actionBox) });
    items.push({ label: "pane root box", value: box(rendered.rootBox) });
  }
  // Host-context intake (t_054750c9): which carrier told this open pane about
  // the active chat, how often, and where the chat scope moved. This is the
  // read-back that replaces "please describe what you see" with a fact.
  const contextSync = asObject(record.contextSync);
  if (contextSync) {
    const carriers = Array.isArray(contextSync.carriers) ? contextSync.carriers : [];
    const eventTypes = Array.isArray(contextSync.eventTypes) ? contextSync.eventTypes : [];
    const chatIds = Array.isArray(contextSync.chatIds) ? contextSync.chatIds : [];
    const number = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : "0");
    items.push({ label: "host context events", value: number(contextSync.hostEvents) });
    items.push({ label: "host context carriers", value: carriers.length ? carriers.join(", ") : "(none)" });
    items.push({ label: "host event types", value: eventTypes.length ? eventTypes.join(", ") : "(none)" });
    items.push({ label: "pane re-scopes", value: number(contextSync.rescopes) });
    items.push({
      label: "re-scope chat ids",
      value: chatIds.length ? chatIds.map((/** @type {unknown} */ id) => (typeof id === "string" ? id : "(unresolved)")).join(" -> ") : "(none)"
    });
    items.push({ label: "foreign pushes dropped", value: number(contextSync.foreignPushes) });
  }
  return items;
}

/**
 * Merges token maps from several host sources into one, keeping the last
 * non-blank string seen for each name. Sources are read in freshness order
 * (snapshot → live getter → event payload), so a `surface.themeChanged`
 * payload wins over a stale snapshot. Never throws: a throwing getter, a
 * non-object, or a non-string value simply contributes nothing.
 * @param {...unknown} sources
 */
export function mergeThemeTokens(...sources) {
  /** @type {Record<string, string>} */
  const tokens = {};
  for (const source of sources) {
    const record = asObject(source);
    if (!record) continue;
    for (const [name, value] of Object.entries(record)) {
      const text = asNonBlankString(value);
      if (typeof name === "string" && name.startsWith("--") && text) tokens[name] = text;
    }
  }
  return tokens;
}

/**
 * Resolves the pane's `--rv-*` inline style for one token set.
 *
 * `set` holds aliases the host actually answered for — the value is the host's
 * own token value, never a colour authored here. `remove` holds the aliases
 * this token set does NOT answer for: clearing them lets the stylesheet's
 * fallback chain take over instead of leaving the previous theme's value
 * behind (the light→dark→light round trip).
 * @param {unknown} tokens
 */
export function paneThemeStyle(tokens) {
  const record = asObject(tokens) ?? {};
  /** @type {Record<string, string>} */
  const set = {};
  /** @type {string[]} */
  const remove = [];
  for (const entry of PANE_THEME_ALIASES) {
    const answered = entry.chain
      .map((/** @type {string} */ token) => asNonBlankString(record[token]))
      .find(Boolean);
    if (answered) set[entry.alias] = answered;
    else remove.push(entry.alias);
  }
  return { set, remove };
}
