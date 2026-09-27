// @ts-check
// Persistent review pane — custom UI entry mounted by the host popup frame.
//
// Thin DOM glue only: every decision (list model, copy, formatting, confirm
// requests) comes from review-pane.js, and the review workflow itself lives in
// review-core.js / review-history.js — the shared core from card B, called
// with this frame's SurfaceApi bridge. No second implementation.
//
// Conventions followed (Msty Go extension conventions):
// - host theme tokens aliased into a local --rv-* namespace (view.css)
// - shared icon sprite (`#msty-icon-*`) for every glyph
// - header action delivered as a `surface.headerAction` event
// - disposables removed on `pagehide`
// - scrollbars, fonts, backgrounds stay host-owned
//
// The stylesheet reaches this frame through the MODULE GRAPH (t_6c564822). The
// host injects a custom entry's CSS because the entry imports it and by no other
// route: the manifest has no style field at all, so the import below is what makes
// the host apply `view.css`. Every shipped entry does exactly this — in the popup
// case the sheet is not even named after the entry (`ui.css`) — and the authoring
// guide says
// so: "Side-effect CSS imports such as `import \"./ui.css\";` are injected into
// the sandbox frame" (Msty extension authoring guide:1258). Without it the
// pane rendered as a bare form under the host's base styles, which is exactly the
// 2026-09-23 report this card fixes.
import "./view.css";

import {
  ACTION_MARKER_TOKEN,
  COPY,
  PANE_CLEAR_ACTION_ID,
  PANE_THEME_PROBE_TOKENS,
  THEME_REPORT_STORAGE_KEY,
  badgeText,
  buildPaneModel,
  buildPaneThemeReport,
  clearAllConfirmRequest,
  deleteConfirmRequest,
  mergeThemeTokens,
  mountContextChatId,
  mountContextHasChat,
  paneSchemeFrom,
  paneThemeStyle,
  parsePaneContext,
  toggleExpandedId
} from "./review-pane.js";
import {
  appendReview,
  clearReviews,
  deleteReview,
  listReviews,
  reportPersistenceFailure,
  sendReviewToComposer,
  updateReviewBody
} from "./review-history.js";
import { completionBlock, executeReview, parseRevisionBody } from "./review-core.js";

/**
 * @typedef {{entries: any[], expandedIds: string[], editingId: string|null, draftBody: string, runnerPhase: string, instruction: string, runningInstruction: string, completionDismissed: boolean, failureStage: string|null, failureDetail: string|null, hasChat: boolean, chatId: string|null, completionBody: string|null, themeChangedFired: boolean, hostContextEvents: number, carriers: string[], hostEventTypes: string[], rescopeCount: number, rescopeChatIds: Array<string|null>, foreignPushCount: number}} PaneState
 */

/** How many host event type names the frame remembers for the report. */
const HOST_EVENT_TYPE_LOG_LIMIT = 12;
/** How many resolved chat ids the frame remembers for the report. */
const RESCOPE_CHAT_ID_LOG_LIMIT = 12;
/** The carriers' names are fixed; any other is recorded as an unknown. */
const MAX_REPORTED_CARRIERS = 8;
/**
 * An app-event NAME that may mean "the active chat changed" (t_054750c9). The
 * `msty.events` stream is app-wide, so a scope re-check is warranted only for an
 * event that names a chat in its payload or is named like one; the exact
 * vocabulary is the host's, and the frame records what it actually sees in the
 * report rather than assuming a name.
 */
const CHAT_EVENT_NAME = /chat|conversation|active/i;

/**
 * @param {Document} documentHost
 * @param {string} tag @param {string} [className] @param {string} [text]
 * @returns {HTMLElement}
 */
function el(documentHost, tag, className, text) {
  /** @type {any} */
  const node = documentHost.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The waiting state's mark: a ring drawn in the pane's own tones (track
 * `--rv-border`, head `--rv-action`) that rotates while a review runs — and
 * holds still, still visible, under `prefers-reduced-motion: reduce` (both are
 * `view.css` rules). It is decorative: the copy beside it carries the meaning,
 * so it is hidden from assistive tech. Its box is the glyph box the state
 * already reserved, so the mark appearing or going cannot move the panel's
 * layout (t_4a9ba0ca).
 * @param {Document} documentHost
 * @returns {HTMLElement}
 */
function spinnerNode(documentHost) {
  const mark = el(documentHost, "span", "rv-spinner");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/**
 * @param {Document} documentHost @param {string} iconName one of the documented sprite names
 * @returns {SVGElement}
 */
function svgIcon(documentHost, iconName) {
  const ns = "http://www.w3.org/2000/svg";
  /** @type {any} */
  const svg = documentHost.createElementNS(ns, "svg");
  svg.setAttribute("class", "rv-icon");
  /** @type {any} */
  const use = documentHost.createElementNS(ns, "use");
  use.setAttribute("href", `#msty-icon-${iconName}`);
  svg.appendChild(use);
  return svg;
}

/**
 * Mount entry point — called by the host with `{ root, msty, context }`.
 * Renders a visible shell synchronously BEFORE any await so the frame never
 * shows a blank rectangle while history loads.
 * @param {{root: HTMLElement, msty: any, context?: any}} mountArgs
 */
export function mount(mountArgs) {
  const root = mountArgs.root;
  const msty = mountArgs.msty;
  const context = mountArgs.context;
  /** @type {any} */
  const documentHost = root?.ownerDocument ?? globalThis.document;

  // The host mounts us into its own container; `.rv-root` is the pane's own root
  // rule (flex column, ink and font from the host aliases). The shipped entries
  // style the frame's `body` instead; the host's container is the node we are
  // handed, so the class goes
  // there. Best-effort: a root without `classList` keeps the host's own layout.
  try {
    root?.classList?.add("rv-root");
  } catch {
    // the host's container styling stands in for `.rv-root`
  }

  /**
   * The pane's ONE primary action, remembered for the rendered snapshot below.
   * @type {any}
   */
  let primaryActionNode = null;

  /**
   * The rows of the LAST full paint, keyed by row id, so a row head can toggle
   * its own subtree without rebuilding the list (t_4a9ba0ca). Every full paint
   * re-seeds it; the local toggle is the only other writer.
   * @type {Map<string, {container: any, chev: any, head: any, detail: any|null, row: any, framing: string}>}
   */
  let rowNodes = new Map();

  /** @type {any[]} */
  const disposables = [];
  /**
   * Whether THIS frame holds a review run of its own (t_054750c9). Distinct
   * from `state.runnerPhase` on purpose: a chat switch idles the visible phase
   * (the previous chat's progress must not sit in the new chat's pane) while
   * the run itself is still in flight, and it must not be startable twice.
   */
  let runInFlight = false;
  /** @type {PaneState} */
  const state = {
    entries: [],
    expandedIds: [],
    /**
     * The one row currently in its EDIT state, or null (t_db84b23e), and the
     * live draft its field holds. The draft lives here, not only in the field,
     * so a repaint while the user types (a host push, a refresh) cannot throw
     * their text away; entering the state seeds it from the row's initial value
     * (`row.draftBody` — the stored edited body, else the derived one).
     */
    editingId: null,
    draftBody: "",
    // Lifecycle phase of the REVIEW WORKFLOW (runner-pushed or own run):
    // "idle" | "running" | "complete" | "failed". The frame's own Review
    // button writes it for its own runs; the extension runner pushes it via
    // surface context so /review progress renders in-frame too.
    runnerPhase: "idle",
    instruction: "",
    /**
     * The focus line the RUNNING panel shows (t_07094a37). It is its own copy,
     * captured when the run starts, because the footer field and `instruction`
     * are cleared at that same moment (item 3): the run has already taken the
     * value, and the progress panel must keep showing what is running.
     */
    runningInstruction: "",
    /**
     * Whether the user dismissed the current success callout (t_07094a37). The
     * callout persists across repaints until a new run finishes — and once
     * dismissed it must NOT reappear on a repaint, so the flag lives in state
     * and is reset by the next completion (never by a paint).
     */
    completionDismissed: false,
    failureStage: null,
    // Bounded reason for the failure stage token (t_fa7ab623): rendered as a
    // secondary prose line under the token, never as the primary copy.
    failureDetail: null,
    hasChat: mountContextHasChat(context),
    // Active chat id, resolved from the mount context and re-resolved on
    // every pushed surface context. Every history call passes it so the list,
    // append, delete, and clear paths all stay scoped to THIS chat — cross-
    // chat entries (host-scope bleed or foreign documents) never render.
    chatId: mountContextChatId(context),
    completionBody: null,
    /**
     * Whether `surface.themeChanged` has fired in this frame's lifetime
     * (t_5bffad26). Reported by /hermes_review_diagnose so a native run tells
     * us whether the host re-announces the theme at all.
     */
    themeChangedFired: false,
    /**
     * Host-context intake instrument (t_054750c9). The pane learns about the
     * active chat through a carrier the HOST chooses — `surface.updated`, a
     * wildcard surface event, the documented `msty.events.subscribe` stream, or
     * a plain window focus when the host announces nothing. Which one actually
     * fires in the installed host is not knowable offline, so every carrier is
     * subscribed and this counter says what arrived: one pane open, read back
     * through /hermes_review_diagnose, answers "does the host push at all, and
     * through which channel" without a screenshot.
     */
    hostContextEvents: 0,
    /** Distinct carrier names that delivered those events, in arrival order. */
    carriers: [],
    /** Distinct host event TYPE names seen (bounded) — the raw vocabulary. */
    hostEventTypes: [],
    /** How many times the pane re-scoped itself to a different chat. */
    rescopeCount: 0,
    /** The chat id resolved at each re-scope, oldest first (bounded). */
    rescopeChatIds: [],
    /**
     * Pushes about a chat that was NOT the active one: a late lifecycle push
     * for the chat a run belongs to must never write its progress, rows or
     * failure text into the chat the user is now looking at.
     */
    foreignPushCount: 0
  };

  // --- theme adaptation (t_0025dae6) ---
  // User requirement: "when Msty Go changes to dark theme and vice versa, our
  // UI needs to change as well." The CSS alias chains in view.css follow the
  // host on their own; this runtime path makes adaptation deterministic on a
  // host that re-announces a theme without re-applying variables to an
  // already-mounted frame. Values written here are the host's own token
  // values, or cleared so the stylesheet chain answers — no colour is ever
  // authored in this file.
  /** @param {unknown} event @returns {Record<string,string>} merged live token set */
  function readLiveThemeTokens(event) {
    /** @type {unknown[]} */
    const sources = [];
    /** @param {() => unknown} read */
    const collect = (read) => {
      try {
        const value = read();
        if (value && typeof value === "object") sources.push(value);
      } catch {
        // an unavailable token source simply contributes nothing
      }
    };
    collect(() => msty?.surface?.getSnapshot?.()?.theme?.tokens);
    collect(() => msty?.theme?.tokens);
    collect(() => msty?.theme?.getTokens?.());
    collect(() => /** @type {any} */ (event)?.data?.theme?.tokens);
    collect(() => /** @type {any} */ (event)?.theme?.tokens);
    collect(() => /** @type {any} */ (event)?.data?.tokens);
    return mergeThemeTokens(...sources);
  }

  /**
   * Reads the host's reported colour scheme from every documented carrier:
   * the surface snapshot, `SurfaceTheme.colorScheme`, and the
   * `surface.themeChanged` payload. Never throws; an unavailable carrier
   * contributes nothing.
   * @param {unknown} [event]
   * @returns {string|null}
   */
  function readHostScheme(event) {
    /** @type {unknown[]} */
    const candidates = [];
    /** @param {() => unknown} read */
    const collect = (read) => {
      try {
        candidates.push(read());
      } catch {
        // an unavailable scheme source simply contributes nothing
      }
    };
    collect(() => msty?.surface?.getSnapshot?.()?.theme?.colorScheme);
    collect(() => msty?.surface?.theme?.colorScheme);
    collect(() => msty?.theme?.colorScheme);
    collect(() => /** @type {any} */ (event)?.data?.theme?.colorScheme);
    collect(() => /** @type {any} */ (event)?.theme?.colorScheme);
    collect(() => /** @type {any} */ (event)?.data?.colorScheme);
    return paneSchemeFrom(...candidates) === "dark" ? "dark"
      : candidates.some((value) => typeof value === "string" && value.trim().toLowerCase() === "light") ? "light"
        : null;
  }

  /**
   * Reads the COMPUTED value of every probe token off the pane root, so the
   * diagnostic reports what the frame's stylesheet actually resolved rather
   * than what a token source claimed (t_5bffad26). A frame without
   * `getComputedStyle` (a synthetic test frame, or a frame whose window is not
   * the document's) reports nothing instead of throwing.
   * @returns {Record<string, string>}
   */
  function readComputedThemeTokens() {
    /** @type {Record<string, string>} */
    const computed = {};
    try {
      const view = documentHost?.defaultView ?? globalThis;
      const target = root ?? documentHost?.documentElement;
      const readStyle = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(target) : null;
      for (const name of PANE_THEME_PROBE_TOKENS) {
        const value = readStyle?.getPropertyValue?.(name);
        if (typeof value === "string" && value.trim()) computed[name] = value.trim();
      }
    } catch {
      // computed-style reading is diagnostic only
    }
    return computed;
  }

  /**
   * Enumerates the sheets the FRAME document holds (t_6c564822): per sheet the
   * owner element, the href, and the rule count. This is the reading that turns
   * "was our stylesheet applied at all?" into a fact — a pane whose sheet never
   * arrived reports zero sheets (or only the host's own base sheet). A sheet
   * whose rule list is cross-origin-guarded is reported `unreadable` rather than
   * throwing.
   * @returns {Array<{href: string, owner: string|null, rules: number|null, unreadable: boolean}>}
   */
  function readStyleSheets() {
    /** @type {Array<{href: string, owner: string|null, rules: number|null, unreadable: boolean}>} */
    const sheets = [];
    try {
      const list = documentHost?.styleSheets;
      if (!list) return sheets;
      for (const sheet of Array.from(list)) {
        let rules = null;
        let unreadable = false;
        try {
          rules = typeof sheet?.cssRules?.length === "number" ? sheet.cssRules.length : null;
        } catch {
          unreadable = true;
        }
        sheets.push({
          href: typeof sheet?.href === "string" && sheet.href ? sheet.href : "(inline)",
          owner: typeof sheet?.ownerNode?.tagName === "string" ? sheet.ownerNode.tagName.toLowerCase() : null,
          rules,
          unreadable
        });
      }
    } catch {
      // a document without a stylesheet list simply reports none
    }
    return sheets;
  }

  /**
   * Reads what the frame ACTUALLY rendered (t_6c564822): the sheets present, the
   * computed value of the pane's own marker property, and the computed paint and
   * box of the one primary action. Values are read, never authored, and this
   * function never touches the DOM — it is safe to call from the report path,
   * which is never awaited and never a render input.
   * @returns {Record<string, unknown>|null}
   */
  function readRenderedFacts() {
    try {
      const view = documentHost?.defaultView ?? globalThis;
      const readStyle = (/** @type {any} */ node) =>
        node && typeof view?.getComputedStyle === "function" ? view.getComputedStyle(node) : null;
      const boxOf = (/** @type {any} */ node) => {
        const rect = node?.getBoundingClientRect?.();
        if (!rect) return null;
        return { width: rect.width, height: rect.height };
      };
      const rootStyle = readStyle(root);
      const actionStyle = readStyle(primaryActionNode);
      return {
        styleSheets: readStyleSheets(),
        marker: rootStyle?.getPropertyValue?.(ACTION_MARKER_TOKEN) ?? null,
        action: actionStyle
          ? {
              className: typeof primaryActionNode?.className === "string" ? primaryActionNode.className : "",
              backgroundColor: actionStyle.backgroundColor,
              color: actionStyle.color,
              borderRadius: actionStyle.borderRadius,
              boxShadow: actionStyle.boxShadow,
              padding: `${actionStyle.paddingTop} ${actionStyle.paddingRight} ${actionStyle.paddingBottom} ${actionStyle.paddingLeft}`,
              fontSize: actionStyle.fontSize
            }
          : null,
        actionBox: boxOf(primaryActionNode),
        rootBox: boxOf(root)
      };
    } catch {
      // the rendered snapshot is diagnostic evidence, never a pane requirement
    }
    return null;
  }

  /**
   * Publishes one theme observation for `/hermes_review_diagnose`
   * (t_5bffad26). The frame is the only place the live theme is visible: the
   * runtime has no DOM and no theme API, so the frame leaves its report in
   * `storage.chat` (the scope this extension already uses) and the diagnostic
   * reads it back. Best-effort and never awaited: a host without `storage.chat`
   * simply has no frame report to show.
   * @param {{tokens?: unknown, hostScheme?: string|null, scheme?: string|null}} payload
   */
  function publishThemeReport(payload) {
    /** @type {any} */
    let report = null;
    try {
      report = buildPaneThemeReport({
        scheme: payload.scheme ?? null,
        hostScheme: payload.hostScheme ?? null,
        themeChangedFired: state.themeChangedFired,
        computed: readComputedThemeTokens(),
        tokens: payload.tokens ?? {},
        rendered: readRenderedFacts(),
        contextSync: {
          hostEvents: state.hostContextEvents,
          carriers: state.carriers,
          eventTypes: state.hostEventTypes,
          rescopes: state.rescopeCount,
          chatIds: state.rescopeChatIds,
          foreignPushes: state.foreignPushCount
        },
        at: new Date().toISOString()
      });
      const result = msty?.storage?.chat?.set?.(THEME_REPORT_STORAGE_KEY, report);
      if (result && typeof result.then === "function") result.catch(() => {});
    } catch {
      // the report is diagnostic evidence, never a pane requirement
    }
    return report;
  }

  /**
   * Writes the resolved `--rv-*` values onto the pane root, stamps the scheme
   * the pane resolved for itself, and refreshes the diagnostic report. Returns
   * the token set it used (exposed for tests/introspection).
   * @param {unknown} [event]
   */
  function applyPaneTheme(event) {
    const tokens = readLiveThemeTokens(event);
    const hostScheme = readHostScheme(event);
    const scheme = paneSchemeFrom(hostScheme);
    try {
      /** @type {any} */ (root).dataset.rvScheme = scheme;
    } catch {
      // a root without a dataset keeps the light palette declared on :root
    }
    const style = paneThemeStyle(tokens);
    for (const [name, value] of Object.entries(style.set)) {
      try {
        root.style.setProperty(name, value);
      } catch {
        // a root without a style sheet keeps the view.css chain
      }
    }
    for (const name of style.remove) {
      try {
        root.style.removeProperty(name);
      } catch {
        // nothing was set inline; the stylesheet chain already answers
      }
    }
    publishThemeReport({ tokens, hostScheme, scheme });
    return tokens;
  }

  /**
   * Publishes the frame's current theme + host-context report without changing
   * any painted value (t_054750c9). Called when the pane re-scopes, so the
   * instrument in `storage.chat` describes the mount that actually switched
   * chats. Best-effort and never awaited — evidence, never a render input.
   */
  function publishCurrentThemeReport() {
    const hostScheme = readHostScheme(null);
    return publishThemeReport({ tokens: readLiveThemeTokens(null), hostScheme, scheme: paneSchemeFrom(hostScheme) });
  }

  /**
   * Records one delivery on a subscribed host-context carrier for the
   * diagnostic report (t_054750c9), and remembers the host's own event TYPE
   * vocabulary (bounded) so one native read-back says which event names the
   * host actually sends. Best-effort: an event without a type is counted, not
   * named.
   * @param {unknown} carrier @param {unknown} eventType
   */
  function recordHostContextEvent(carrier, eventType) {
    state.hostContextEvents += 1;
    const name = typeof carrier === "string" && carrier.trim() ? carrier.trim() : "(unnamed carrier)";
    if (!state.carriers.includes(name) && state.carriers.length < MAX_REPORTED_CARRIERS) state.carriers.push(name);
    const type = typeof eventType === "string" && eventType.trim() ? eventType.trim() : null;
    if (type && !state.hostEventTypes.includes(type) && state.hostEventTypes.length < HOST_EVENT_TYPE_LOG_LIMIT) {
      state.hostEventTypes.push(type);
    }
  }

  /**
   * The chat id the HOST names as active, payload-free: the surface context the
   * host keeps current (`getSnapshot().context` after the open request asked
   * for `contextSync: { activeChat: true }`, d.ts:1527 — the mechanism that
   * merges the active chat into the surface context on open AND chat changes),
   * else `surface.context`, else the host's authoritative
   * `context.getCurrentChat()` (d.ts:1220). The stored `state.chatId` is
   * deliberately not consulted: every caller is answering "which chat is open
   * NOW", and inheriting the stored id is the stale-scope bug (t_61dd1e7e B2).
   * @returns {Promise<string|null>}
   */
  async function resolveHostActiveChatId() {
    const surfaceContext = msty.surface?.getSnapshot?.()?.context ?? msty.surface?.context;
    const surfaceChatId = mountContextChatId(surfaceContext);
    if (surfaceChatId) return surfaceChatId;
    try {
      return mountContextChatId(await msty.context.getCurrentChat());
    } catch {
      // a host that cannot answer contributes nothing (fail closed)
    }
    return null;
  }

  /**
   * Resolves the chat scope the pane should now hold. The host's own answer
   * always wins; a carrier's chat id is only allowed to speak when the host
   * names no chat at all — and then only for a chat-change push, or for the
   * pane's FIRST scope (the runner's auto-open, where `review.chatId` is the
   * extension's only chat-id carrier, t_61dd1e7e B2). A late lifecycle push
   * must never re-point a pane the host has already described.
   * @param {{advisedChatId?: string|null, adoptAdvised?: boolean}} [options]
   * @returns {Promise<{chatId: string|null, hasChat: boolean}>}
   */
  async function resolveActiveChat(options = {}) {
    const advised = typeof options.advisedChatId === "string" && options.advisedChatId.trim()
      ? options.advisedChatId.trim()
      : null;
    const hostChatId = await resolveHostActiveChatId();
    if (hostChatId) return { chatId: hostChatId, hasChat: true };
    if (advised && (options.adoptAdvised === true || !state.hasChat)) return { chatId: advised, hasChat: true };
    return { chatId: state.chatId, hasChat: state.hasChat };
  }

  /**
   * Adopts a resolved chat scope. A CHANGE of scope is a FULL re-scope: the
   * rows, the expansion state and the lifecycle chrome all belong to the
   * previous chat and are dropped before the new chat's own history is read, so
   * the previous chat's reviews — and a run still in flight in it — can never
   * be visible for even one frame in the new chat's pane. An INITIAL adoption
   * (the pane held no chat yet) keeps the lifecycle chrome it just absorbed:
   * the runner's auto-open delivers the running phase before any chat id.
   * @param {{chatId: string|null, hasChat: boolean}} next
   * @returns {boolean} whether the pane's scope changed
   */
  function applyScope(next) {
    const nextChatId = next.chatId ?? null;
    const changed = nextChatId !== (state.chatId ?? null) || next.hasChat !== state.hasChat;
    if (!changed) return false;
    const hadChat = Boolean(state.chatId);
    state.chatId = nextChatId;
    state.hasChat = next.hasChat;
    state.entries = [];
    state.expandedIds = [];
    // An open edit belongs to the row of the chat the pane is leaving: its
    // draft is dropped with the rest of that chat's state (t_db84b23e) rather
    // than being carried into another chat's pane.
    state.editingId = null;
    state.draftBody = "";
    if (hadChat) {
      state.runnerPhase = "idle";
      state.completionBody = null;
      state.failureStage = null;
      state.failureDetail = null;
    }
    state.rescopeCount += 1;
    if (state.rescopeChatIds.length >= RESCOPE_CHAT_ID_LOG_LIMIT) state.rescopeChatIds.shift();
    state.rescopeChatIds.push(nextChatId);
    renderHeaderHint();
    renderBody();
    // The re-scope is the moment the instrument must capture: the report is
    // written under the chat now scoped, so one pane open says whether the host
    // told it about the switch and through which carrier (t_054750c9).
    publishCurrentThemeReport();
    return true;
  }

  /**
   * The pane's ONE host-context intake (t_054750c9): every carrier funnels
   * here, so the re-scope rule is written once. Runner lifecycle pushes
   * (running / complete / failed, conventions §7) are rendered in-frame; a push
   * about a chat that is not the one now open is dropped whole — its stored
   * outcome already lives in its own chat's document, and re-opening that chat
   * renders it.
   * @param {unknown} event @param {string} carrier
   */
  function onHostContextEvent(event, carrier) {
    /** @type {any} */
    const raw = event;
    const pushed = raw?.data?.context ?? raw?.surface?.context;
    recordHostContextEvent(carrier, raw?.type);
    void (async () => {
      const push = parsePaneContext(pushed);
      const pushedChatId = mountContextChatId(pushed);
      const active = await resolveActiveChat({ advisedChatId: pushedChatId, adoptAdvised: !push });
      if (pushedChatId && active.chatId && pushedChatId !== active.chatId) {
        state.foreignPushCount += 1;
        // The host's answer is still the truth about which chat is open: adopt
        // it without the foreign push's chrome.
        if (applyScope(active)) await refresh();
        return;
      }
      applyScope(active);
      absorbLifecyclePush(push);
      renderLifecycle();
      await refresh();
    })().catch(() => {});
  }

  /**
   * Absorbs a lifecycle push the pane has already attributed to the chat it is
   * now scoped to (conventions §7). Takes the PARSED push from
   * `parsePaneContext`, so a caller cannot accidentally feed the parsed shape
   * back through the parser. The push's chat id is NOT consumed here: the scope
   * is owned by applyScope/resolveActiveChat, which alone can tell "the chat
   * this push is about" from "the chat now open".
   * @param {any} push
   */
  function absorbLifecyclePush(push) {
    if (!push) return false;
    state.runnerPhase = push.phase;
    // A new run's focus line is the running panel's own copy (t_07094a37); the
    // footer field's state is not written from a push.
    if (push.instruction !== null) state.runningInstruction = push.instruction;
    // A run STARTING clears a previous dismiss, so ITS completion callout can be
    // seen; a repeated `complete` push for the same run must not resurrect one
    // the user already dismissed (t_07094a37, item 4).
    if (push.phase === "running") state.completionDismissed = false;
    state.completionBody = push.completionBody;
    state.failureStage = push.failureStage;
    state.failureDetail = push.failureDetail;
    return true;
  }

  /** Paints the header hint from the current chat state (D1 t_061370a7). */
  function renderHeaderHint() {
    headerHint.textContent = state.hasChat ? "" : COPY.noChatHeading;
    header.style.display = state.hasChat ? "none" : "";
  }

  // --- static shell (painted synchronously) ---
  // Theme first: the pane's aliases are on the root before the first paint, so
  // an already-open pane follows a theme switch without a remount.
  applyPaneTheme();

  const sheet = el(documentHost, "div", "rv-sheet");
  root.appendChild(sheet);

  // header: the host popup chrome already renders icon + title + window
  // controls (manifest contributes.popups[0]), so the in-view row carries only
  // the chat-state hint, right-aligned, and collapses entirely when empty.
  const header = el(documentHost, "div", "rv-header");
  const headerHint = el(documentHost, "div", "rv-header-hint", state.hasChat ? "" : COPY.noChatHeading);
  header.appendChild(headerHint);
  sheet.appendChild(header);

  const body = el(documentHost, "div", "rv-body");
  sheet.appendChild(body);

  // footer: instruction textarea + the pane's ONE primary action (Review).
  // No status line: the running/failed phases render in the body, and no pane
  // copy names a model (t_0025dae6).
  const footer = el(documentHost, "div", "rv-footer");
  /** @type {any} */
  const field = documentHost.createElement("textarea");
  field.className = "rv-field";
  field.placeholder = COPY.footerPlaceholder;
  field.rows = 2;
  field.addEventListener("input", () => {
    state.instruction = String(field.value ?? "");
  });
  footer.appendChild(field);

  const footerMeta = el(documentHost, "div", "rv-footer-meta");
  /** @type {any} */
  const runButton = documentHost.createElement("button");
  runButton.className = "rv-btn rv-btn--primary";
  runButton.type = "button";
  runButton.textContent = COPY.footerButton;
  primaryActionNode = runButton;
  footerMeta.appendChild(runButton);
  footer.appendChild(footerMeta);
  sheet.appendChild(footer);

  /**
   * Labels the footer's ONE action for the current phase (t_6c564822). The dummy
   * puts the retry where the primary action sits — the footer (design reference
   * state 4: `.ftrow` holds a single `Retry` button and
   * the failure callout holds none) — so a failed run re-labels the footer action
   * instead of adding a second one. Clicking it is the same `runReview` call
   * either way.
   */
  function renderFooterAction() {
    const failed = state.runnerPhase === "failed";
    runButton.textContent = failed ? COPY.retryAction : COPY.footerButton;
    runButton.dataset.rvAction = failed ? COPY.retryAction : COPY.footerButton;
  }

  /** Paints the scrollable main region from the current state. */
  function renderBody() {
    renderFooterAction();
    while (body.firstChild) body.removeChild(body.firstChild);
    const model = buildPaneModel({
      entries: state.entries,
      expandedIds: state.expandedIds,
      editingId: state.editingId,
      running: state.runnerPhase === "running",
      instruction: state.instruction,
      failureStage: state.failureStage,
      failureDetail: state.failureDetail
    });

    const showingLifecycle =
      state.runnerPhase === "running" ||
      state.runnerPhase === "failed" ||
      Boolean(state.completionBody);
    if (!state.hasChat && !showingLifecycle) {
      // The "No active chat" empty state must never blank lifecycle chrome
      // (a runner push can arrive before the host's chat context).
      const empty = el(documentHost, "div", "rv-empty");
      empty.appendChild(el(documentHost, "div", "rv-empty-heading", COPY.emptyHeading));
      empty.appendChild(el(documentHost, "div", "rv-empty-note", COPY.noChatNote));
      body.appendChild(empty);
      return;
    }

    if (state.runnerPhase === "running") {
      // The dummy's `.prog` (state 2): a raised, bordered panel whose title is
      // bold and whose focus line is a muted sub-line — not a borderless row.
      const running = el(documentHost, "div", "rv-running");
      running.appendChild(spinnerNode(documentHost));
      const runningCopy = el(documentHost, "div", "rv-running-copy");
      runningCopy.appendChild(el(documentHost, "div", "rv-running-title", COPY.running));
      // The focus line comes from the run's OWN copy (t_07094a37): the footer
      // field and `instruction` were cleared when this run started, and what the
      // user asked for must stay visible while it runs.
      if (state.runningInstruction.trim()) {
        runningCopy.appendChild(el(documentHost, "div", "rv-running-instruction", state.runningInstruction.trim()));
      }
      running.appendChild(runningCopy);
      body.appendChild(running);
    }

    // Completion callout: `Reviewed N recent messages.` — model-free pane copy
    // (t_0025dae6; the run's model provenance stays in the stored entry's
    // `modelLabel`, which is never rendered). It persists across repaints until
    // the next run starts — and until the user dismisses it (t_07094a37): the
    // dismiss control below is a real, visible button, and `completionDismissed`
    // is what keeps a dismissed callout gone through a later paint.
    if (state.completionBody && !state.completionDismissed) {
      const done = el(documentHost, "div", "rv-callout rv-callout--success");
      const doneHead = el(documentHost, "div", "rv-callout-head");
      doneHead.appendChild(el(documentHost, "div", "rv-callout-title", COPY.calloutCompleteTitle));
      const dismiss = actionButton("rv-btn rv-btn--ghost rv-callout-dismiss", COPY.calloutDismiss);
      dismiss.setAttribute("aria-label", COPY.calloutDismissLabel);
      dismiss.addEventListener("click", () => dismissCompletionCallout());
      doneHead.appendChild(dismiss);
      done.appendChild(doneHead);
      done.appendChild(el(documentHost, "div", "rv-callout-body", state.completionBody));
      body.appendChild(done);
    }

    if (model.failure) {
      const callout = el(documentHost, "div", "rv-callout rv-callout--danger");
      callout.appendChild(el(documentHost, "div", "rv-callout-title", COPY.failureTitle));
      // One plain sentence in front of the load-bearing stage token
      // (t_0025dae6). The sentence names no model.
      callout.appendChild(el(documentHost, "div", "rv-callout-body", COPY.failureSentence));
      callout.appendChild(el(documentHost, "div", "rv-callout-body rv-callout-body--token", model.failure.stageToken));
      // Secondary reason line (t_fa7ab623): the bounded, credential-free cause
      // the runner preserved. Prose, not the token surface — the token above
      // stays exactly as it was. Absent when the push carried no detail.
      if (model.failure.detail) {
        callout.appendChild(el(documentHost, "div", "rv-callout-detail", `${COPY.failureDetailLabel}: ${model.failure.detail}`));
      }
      // No button here (t_6c564822): the dummy's failure callout is words only
      // and its retry sits in the footer, so the footer action carries it.
      body.appendChild(callout);
    }

    if (!model.hasReviews) {
      // Heading + ONE hint sentence, nothing else (t_0025dae6).
      const empty = el(documentHost, "div", "rv-empty");
      empty.appendChild(el(documentHost, "div", "rv-empty-heading", COPY.emptyHeading));
      empty.appendChild(el(documentHost, "div", "rv-empty-note", COPY.emptyNote));
      body.appendChild(empty);
      return;
    }

    body.appendChild(el(documentHost, "div", "rv-count", model.countLine));
    const list = el(documentHost, "div", "rv-list");
    // A full paint is the ONLY path that rebuilds the list, so the local-toggle
    // registry is re-seeded here and every row registers the nodes its own head
    // needs (t_4a9ba0ca).
    rowNodes = new Map();
    for (const row of model.rows) list.appendChild(paneRowNode(row, model.framing));
    body.appendChild(list);
  }

  /**
   * @param {string} label @param {string} text
   */
  function labeledLine(label, text) {
    const line = el(documentHost, "p", "rv-issue-line");
    if (label) line.appendChild(el(documentHost, "b", "", label));
    line.appendChild(el(documentHost, "span", "", text));
    return line;
  }

  /**
   * One recognised issue drawn as a REAL `.rv-issue` card — the same nodes, the
   * same classes and the same three labelled lines the structured read-only path
   * builds, so an edited and an unedited row are visually indistinguishable when
   * their text is structurally the same (t_e01f96e1).
   *
   * The severity comes from the text that is drawn: an edited body is what the
   * user wrote and what gets sent, so its chips follow it. The row's HEADER
   * keeps the review's original count/severity data and the `edited` marker
   * explains the difference — state 4 of the design reference.
   * @param {{severity: string, title: string, location: string, problem: string, correction: string}} issue
   */
  function issueCardNode(issue) {
    const issueNode = el(documentHost, "div", "rv-issue");
    issueNode.dataset.sev = issue.severity;
    const chip = el(documentHost, "span", "rv-chip", issue.severity);
    chip.dataset.sev = issue.severity;
    issueNode.appendChild(chip);
    issueNode.appendChild(el(documentHost, "div", "rv-issue-title", issue.title));
    issueNode.appendChild(labeledLine("Location: ", issue.location));
    issueNode.appendChild(labeledLine("", issue.problem));
    issueNode.appendChild(labeledLine("Correction: ", issue.correction));
    return issueNode;
  }

  /**
   * The edited row's expanded body (t_e01f96e1): the STORED text is parsed at
   * RENDER time — never at save time, so no derived state is persisted and the
   * one representation stays the one that is sent — into the segments of the
   * body grammar this repo writes (`review-core.js` `parseRevisionBody`).
   *
   * Recognised issues are drawn as real `.rv-issue` cards, the summary as the
   * structured path's `.rv-summary`, and every block the grammar does not
   * recognise as a `.rv-stored` paragraph, verbatim.
   *
   * The whole-document fallback stays: when nothing parses, the row renders
   * exactly as it did before this card — one `.rv-stored` paragraph of the
   * verbatim text. Worst case this release changes nothing.
   * @param {any} detail the row detail the segments are appended to
   * @param {string} editedBody
   */
  function appendEditedBody(detail, editedBody) {
    const parsed = parseRevisionBody(editedBody);
    if (!parsed.structured) {
      detail.appendChild(el(documentHost, "p", "rv-stored", editedBody));
      return;
    }
    for (const segment of parsed.segments) {
      if (segment.kind === "summary") detail.appendChild(el(documentHost, "p", "rv-summary", segment.text));
      else if (segment.kind === "issue") detail.appendChild(issueCardNode(segment));
      else if (segment.kind === "prose") detail.appendChild(el(documentHost, "p", "rv-stored", segment.text));
      // `issues-heading` is a structural marker: neither this path nor the
      // read-only structured path draws it.
    }
  }

  /**
   * One word-button in a row's action row. `--primary` is reserved for the one
   * filled action a state carries (the footer's Review/Retry, or the edit
   * state's Save) and `--secondary` for the row's Send action — the new Edit
   * button uses the pane's plain raised recipe, so it reads against its own
   * fill in either host theme (asserted offline by
   * `tests/hermes-review-token-vocabulary-contract.mjs`, VS8).
   * @param {string} className @param {string} label
   */
  function actionButton(className, label) {
    /** @type {any} */
    const node = documentHost.createElement("button");
    node.className = className;
    node.type = "button";
    node.textContent = label;
    return node;
  }

  /**
   * The "edited" marker on a collapsed row's meta line (t_db84b23e, design §9
   * variant A): the shared sprite's pen glyph plus the word, in the pane's muted
   * ink, beside the timestamp. It is the ONLY thing that explains why a row
   * whose header still carries the review's original count and severity data
   * shows different text — editing never re-derives issues.
   */
  function editedMarkerNode() {
    const marker = el(documentHost, "span", "rv-edited");
    marker.appendChild(svgIcon(documentHost, "pencil"));
    marker.appendChild(el(documentHost, "span", "", COPY.editedMarker));
    return marker;
  }

  /**
   * The edit state's static framing block (design §9 state 5): the constant
   * sentence is DRAWN, never placed in the field, so no edit can reach it. The
   * sentence itself comes from `review-core.js` through the model — the pane
   * keeps no copy of it.
   * @param {string} framing
   */
  function editFramingNode(framing) {
    const block = el(documentHost, "div", "rv-framing");
    block.appendChild(el(documentHost, "span", "rv-framing-label", COPY.editFramingLabel));
    block.appendChild(el(documentHost, "p", "rv-framing-text", framing));
    return block;
  }

  /**
   * The editable field: the review BODY only, in the pane's own raised-field
   * recipe. The live draft lives in `state.draftBody`, so a repaint cannot drop
   * what the user has typed.
   * @param {any} row
   */
  function editFieldNode(row) {
    /** @type {any} */
    const field = documentHost.createElement("textarea");
    field.className = "rv-editbody";
    field.rows = 9;
    field.value = state.draftBody;
    field.setAttribute("aria-label", COPY.editFieldLabel);
    field.setAttribute("spellcheck", "false");
    field.addEventListener("input", () => {
      state.draftBody = String(field.value ?? "");
    });
    return field;
  }

  /**
   * Leaves the edit state without writing anything (Cancel): the draft is
   * dropped and the row returns to its read-only expanded view.
   */
  function cancelEdit() {
    state.editingId = null;
    state.draftBody = "";
    renderBody();
  }

  /**
   * Dismisses the success callout (t_07094a37, item 4). The click is answered by
   * a REAL repaint rather than by hiding one node, so the flag and the DOM can
   * never disagree; a later repaint reads `completionDismissed` and does not
   * bring the callout back. Only the next run resets it.
   */
  function dismissCompletionCallout() {
    state.completionDismissed = true;
    renderBody();
  }

  /**
   * Saves the draft onto THAT history entry (never another chat's document) and
   * returns the row to read-only. The pane leaves the edit state immediately —
   * the "edited" marker (or the unchanged row, when nothing was stored) is the
   * confirmation — and a rejected write is reported with the history
   * persistence toast while storage keeps the previous body.
   * @param {string} rowId
   */
  async function saveEdit(rowId) {
    const body = state.draftBody;
    state.editingId = null;
    state.draftBody = "";
    try {
      const result = await updateReviewBody(msty, rowId, body, state.chatId);
      if (result.persisted === false && result.unavailable !== true) {
        await reportPersistenceFailure(msty);
      }
    } catch {
      try {
        await reportPersistenceFailure(msty);
      } catch {
        // the in-memory list still shows the review for this session
      }
    }
    await refresh();
  }

  /**
   * The edit state's action row: Cancel (ghost) then Save (primary) — secondary
   * left, primary right, inside the item the user is editing (design §9 state
   * 5). No host round trip.
   * @param {any} row
   */
  function editActionsNode(row) {
    const actions = el(documentHost, "div", "rv-row-actions");
    const cancelButton = actionButton("rv-btn rv-btn--ghost", COPY.cancelAction);
    cancelButton.addEventListener("click", () => cancelEdit());
    const saveButton = actionButton("rv-btn rv-btn--primary", COPY.saveAction);
    saveButton.addEventListener("click", () => {
      void saveEdit(row.id);
    });
    actions.appendChild(cancelButton);
    actions.appendChild(saveButton);
    return actions;
  }

  /**
   * The read-only action row: Edit first, then the constructive Send action,
   * then the destructive Delete — the order the design reference
   * draws (state 3) and PS8 pins.
   * @param {any} row
   */
  function readOnlyActionsNode(row) {
    const actions = el(documentHost, "div", "rv-row-actions");
    const editButton = actionButton("rv-btn", COPY.editAction);
    editButton.addEventListener("click", () => {
      // Seed the draft from the row's initial value: the stored edited body
      // when there is one, the derived body when there is not.
      state.editingId = row.id;
      state.draftBody = row.draftBody;
      renderBody();
    });
    const sendButton = actionButton("rv-btn rv-btn--secondary", COPY.sendAction);
    sendButton.addEventListener("click", () => {
      // Sends the framing sentence plus this row's STORED edited body when it
      // has one (t_db84b23e) — the whole point of the edit feature.
      void sendReviewToComposer(msty, row).catch(() => {});
    });
    const deleteButton = actionButton("rv-btn rv-btn--ghost-danger", COPY.deleteAction);
    deleteButton.addEventListener("click", () => {
      void (async () => {
        const confirmed = await msty.ui.confirm(deleteConfirmRequest());
        if (!confirmed?.confirmed) return;
        await deleteReview(msty, row.id, state.chatId);
        await refresh();
        await toast(COPY.toastDeleted, "success");
      })().catch(() => {});
    });
    actions.appendChild(editButton);
    actions.appendChild(sendButton);
    actions.appendChild(deleteButton);
    return actions;
  }

  /**
   * Applies the chevron's open/closed draw to ONE row's glyph (t_4a9ba0ca). It
   * writes the class ATTRIBUTE — the same route `svgIcon` uses for `rv-icon` —
   * so a toggle repaints the mark without rebuilding the row head that owns it.
   * @param {any} chev @param {boolean} expanded
   */
  function paintChevron(chev, expanded) {
    chev.setAttribute("class", expanded ? "rv-icon rv-chev--open" : "rv-icon rv-chev--closed");
  }

  /**
   * Toggles ONE row's expansion LOCALLY (t_4a9ba0ca): its chevron repaints and
   * its own detail subtree is added or removed, while every other row's nodes
   * stay alive exactly as they were. The reported "slight freeze" came from the
   * full repaint this replaces — one click rebuilt all N rows and re-attached
   * all N click handlers — so this path rebuilds no list, touches no other row,
   * and reads no layout. It also cannot disturb a sibling's live edit field
   * (t_db84b23e): the only subtree it touches is the one it owns.
   * @param {string} rowId @returns {boolean} whether a painted row was toggled
   */
  function toggleRow(rowId) {
    const entry = rowNodes.get(rowId);
    if (!entry) return false;
    const expanded = !state.expandedIds.includes(rowId);
    state.expandedIds = toggleExpandedId(state.expandedIds, rowId);
    paintChevron(entry.chev, expanded);
    // The title's full/one-line draw follows this attribute (t_07094a37, item
    // 1), so the local toggle repaints it on the SAME head node it keeps.
    if (entry.head) entry.head.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (expanded) {
      if (entry.detail === null) {
        entry.detail = rowDetailNode(entry.row, entry.framing);
        entry.container.appendChild(entry.detail);
      }
    } else if (entry.detail !== null) {
      entry.container.removeChild(entry.detail);
      entry.detail = null;
    }
    return true;
  }

  /**
   * One row's expanded subtree — the read-only detail, or the edit state for
   * the row that is being edited (t_db84b23e). Called by the full paint and by
   * the local toggle, so both paths build the same nodes from the same model.
   * @param {any} row @param {string} framing
   */
  function rowDetailNode(row, framing) {
    const detail = el(documentHost, "div", "rv-row-detail");
    if (row.editing) {
      detail.appendChild(editFramingNode(framing));
      detail.appendChild(editFieldNode(row));
      detail.appendChild(editActionsNode(row));
    } else {
      if (row.editedBody !== null) {
        // After an edit the expanded body is the STORED text — never a
        // re-derivation — but it is PARSED AT RENDER TIME into the segments of
        // the body grammar this repo writes, so the row keeps the pane's layout
        // instead of collapsing to one pre-wrapped paragraph (t_e01f96e1). The
        // parse persists nothing: the stored text stays exactly what the user
        // typed and what "Send to composer" sends. When nothing parses, the
        // whole-document fallback renders the verbatim text as it did before.
        appendEditedBody(detail, row.editedBody);
      } else {
        detail.appendChild(el(documentHost, "p", "rv-summary", row.summary));
        for (const issue of row.issues) detail.appendChild(issueCardNode(issue));
      }
      // Action order follows the dummy (state 3 `.acts`): the way in first,
      // then the constructive action, the destructive one last.
      detail.appendChild(readOnlyActionsNode(row));
    }
    return detail;
  }

  /**
   * One review row, registered for the LOCAL toggle (t_4a9ba0ca). The row's
   * head owns exactly this row: clicking it adds or removes this container's
   * own detail subtree and repaints this row's chevron — it never rebuilds the
   * list. The registry is re-seeded by every full paint.
   * @param {any} row @param {string} framing
   */
  function paneRowNode(row, framing) {
    const container = el(documentHost, "div", "rv-row");
    const expanded = state.expandedIds.includes(row.id);

    /** @type {any} */
    const head = documentHost.createElement("button");
    head.className = "rv-row-head";
    head.type = "button";
    // The EXPANDED state is on the head as a real `aria-expanded` (t_07094a37,
    // item 1): it is the honest accessibility state AND the hook `view.css`
    // needs to show the title in full instead of ellipsising it — a collapsed
    // row keeps its one line, an expanded one wraps, and the meta line moves
    // below the title rather than colliding with it.
    head.setAttribute("aria-expanded", expanded ? "true" : "false");
    const chev = svgIcon(documentHost, "chevron-down");
    paintChevron(chev, expanded);
    head.appendChild(chev);
    head.appendChild(el(documentHost, "div", "rv-row-title", row.title));
    // The header keeps the review's ORIGINAL count and severity data; an
    // edited row is explained by the marker, not by re-deriving anything. The
    // marker and the timestamp together are the row's META line, wrapped so the
    // expanded state can put them on their own line under a wrapping title.
    const meta = el(documentHost, "div", "rv-row-meta");
    if (row.isEdited) meta.appendChild(editedMarkerNode());
    meta.appendChild(el(documentHost, "div", "rv-row-time", row.timestampLabel));
    head.appendChild(meta);
    head.addEventListener("click", () => toggleRow(row.id));
    container.appendChild(head);

    /** @type {{container: any, chev: any, head: any, detail: any|null, row: any, framing: string}} */
    const entry = { container, chev, head, detail: null, row, framing };
    rowNodes.set(row.id, entry);
    if (expanded) {
      entry.detail = rowDetailNode(row, framing);
      container.appendChild(entry.detail);
    }
    return container;
  }

  /** Toggles run button while a review runs. */
  function renderRunning() {
    runButton.disabled = runInFlight || state.runnerPhase === "running";
  }

  /**
   * Repaints the lifecycle chrome (running row / completion callout / failure
   * callout) and, on transitions into a terminal phase, pulls the fresh list
   * so the new entry appears without a remount. Never throws.
   */
  function renderLifecycle() {
    renderRunning();
    renderBody();
  }

  /**
   * @param {string} title @param {"success"|"error"|"warning"|"default"} tone
   * @param {string} [body]
   */
  async function toast(title, tone, body) {
    try {
      await msty.notifications.show(body === undefined ? { title, tone, durationMs: 4000 } : { title, body, tone, durationMs: 6000 });
    } catch {
      // toasts are advisory
    }
  }

  /**
   * Pushes the title-bar badge count from the frame (SurfaceApi exposes
   * msty.ui.update) so it stays fresh after pane-side Delete/Clear/append —
   * best-effort: badge staleness is cosmetic, never a failure.
   * @param {number} count
   */
  async function syncBadge(count) {
    try {
      msty.ui.update({
        id: "hermes-review-titlebar",
        surface: "titleBar",
        badge: badgeText(count) || null
      });
    } catch {
      // badge chrome is cosmetic
    }
  }

  /**
   * Re-reads the chat history, repaints, and syncs the launcher badge.
   *
   * The scope is re-resolved on every pass (host answer first, never the stored
   * id) and a change re-scopes the pane BEFORE the read: a late read that
   * belongs to a scope the pane has already left is discarded rather than
   * committed, so a carrier for the previous chat can never paint its rows into
   * the current chat (t_054750c9). A transient read failure keeps the pane's
   * current list — but never the previous chat's, which the re-scope cleared.
   */
  async function refresh() {
    /** @type {string|null} */
    let chatId = state.chatId;
    try {
      const active = await resolveActiveChat({});
      applyScope(active);
      chatId = state.chatId;
      const entries = await listReviews(msty, chatId);
      if (chatId !== state.chatId) return;
      state.entries = entries;
    } catch {
      // keep the previous list; a transient read failure must not blank the pane
      if (chatId !== state.chatId) return;
    }
    renderBody();
    await syncBadge(state.entries.length);
  }

  /**
   * Runs a review with the given optional focus instruction. Mirrors /review:
   * shared core, per-chat persistence, stage-token failure rendered in-pane.
   *
   * The run is bound to the chat it STARTED in (t_054750c9). The review core
   * resolves the chat at the start, so its outcome lands in that chat's
   * document whatever the user does meanwhile; and if the user switches chats
   * while it runs, its progress, completion callout and failure text stay out
   * of the newly opened chat's pane — the pane no longer shows the run at all,
   * and switching back shows the stored review. Only a run refusal (`no run in
   * flight`) is global.
   * @param {string} instruction
   */
  async function runReview(instruction) {
    if (runInFlight) return;
    runInFlight = true;
    const runChatId = state.chatId;
    state.runnerPhase = "running";
    state.failureStage = null;
    state.failureDetail = null;
    state.completionBody = null;
    // Item 3 (t_07094a37): the run has already taken the instruction, so the
    // footer's field AND its state are cleared the moment the run starts. The
    // progress panel keeps showing the focus from the run's OWN copy
    // (`state.runningInstruction`), which is the behaviour to keep — what the
    // user asked for stays visible while the field is empty for the next run.
    state.runningInstruction = typeof instruction === "string" ? instruction.trim() : "";
    state.instruction = "";
    try {
      field.value = "";
    } catch {
      // a field without a settable value keeps its text; the run is unaffected
    }
    // A new run's completion callout must be visible when it arrives, so the
    // previous callout's dismiss does not silence it (t_07094a37, item 4).
    state.completionDismissed = false;
    renderRunning();
    renderBody();
    try {
      const outcome = await executeReview(msty, typeof instruction === "string" ? instruction : "");
      const outcomeChatId = outcome.ok ? (outcome.chatId ?? runChatId) : runChatId;
      // The pane must still be on the chat the run belongs to before any of its
      // chrome is painted — a chat switch in between has already dropped it.
      const stillOnRunChat = state.chatId === outcomeChatId;
      if (!outcome.ok) {
        if (stillOnRunChat) {
          state.failureStage = outcome.stage;
          // The frame's own runs carry the same preserved reason as the runner's.
          state.failureDetail = typeof outcome.detail === "string" ? outcome.detail : null;
          state.runnerPhase = "failed";
        }
        await toast(COPY.toastReviewFailed, "error", `diagnostic-stage=${outcome.stage}`);
      } else {
        try {
          const appended = await appendReview(msty, outcome.review, outcome.meta, outcomeChatId ?? undefined);
          if (appended.persisted === false && appended.unavailable !== true) {
            await reportPersistenceFailure(msty);
          }
        } catch {
          try {
            await reportPersistenceFailure(msty);
          } catch {
            // in-memory list already preserves the review
          }
        }
        if (stillOnRunChat) {
          state.completionBody = completionBlock(outcome.meta.messageCount).body;
          state.runnerPhase = "complete";
        }
        await toast(COPY.toastReviewComplete, "success");
      }
    } catch {
      if (state.chatId === runChatId) {
        state.failureStage = "review-workflow";
        state.failureDetail = null;
        state.runnerPhase = "failed";
      }
      await toast(COPY.toastReviewFailed, "error", "diagnostic-stage=review-workflow");
    } finally {
      runInFlight = false;
      state.runnerPhase = state.runnerPhase === "running" ? "idle" : state.runnerPhase;
      renderRunning();
      await refresh();
    }
  }

  runButton.addEventListener("click", () => {
    void runReview(state.instruction);
  });

  // Header action event: only `clear` (trash) is documented as available.
  try {
    disposables.push(msty.surface.on("surface.headerAction", (/** @type {any} */ event) => {
      void (async () => {
        if (event?.data?.id !== PANE_CLEAR_ACTION_ID) return;
        const confirmed = await msty.ui.confirm(clearAllConfirmRequest());
        if (!confirmed?.confirmed) return;
        await clearReviews(msty, state.chatId);
        await refresh();
        await toast(COPY.toastDeleted, "success");
      })().catch(() => {});
    }));
  } catch {
    // header actions unavailable on this host — the host's own close stays
  }

  // Live theme switching (t_0025dae6, conventions §3): the host re-announces
  // the theme on `surface.themeChanged`. Re-resolve the token set and rewrite
  // the pane root's `--rv-*` values so an already-open pane re-themes — no
  // remount, no reload. Never throws: a host without the event keeps the
  // view.css chain, which already follows the theme.
  try {
    disposables.push(msty.surface.on("surface.themeChanged", (/** @type {any} */ event) => {
      try {
        // Recorded for the diagnostic: whether the host re-announces themes to
        // an already-mounted frame at all (t_5bffad26).
        state.themeChangedFired = true;
        applyPaneTheme(event);
      } catch {
        // theme adaptation is presentation only
      }
    }));
  } catch {
    // host supports remount-only theming; the CSS chains still apply
  }

  // ---------------------------------------------------------------------------
  // Host-context carriers (t_054750c9). The pane must re-scope to the chat the
  // user is now in, and it cannot know offline which channel the installed host
  // actually uses for that: the official Side Chat pane reads
  // `surface.updated` (`event?.data?.context ?? event?.surface?.context`), the
  // authoring guide documents `msty.events.subscribe` as the way a view "updates
  // as the active chat … changes", and the open request already asks the host to
  // keep the active chat merged into the surface context (`contextSync: {
  // activeChat: true }`, extension.js). All of them are subscribed, and every
  // one funnels into `onHostContextEvent` — the re-scope rule is written once.
  // The report says which carrier(s) fired, so one pane open answers the
  // question for good.
  // ---------------------------------------------------------------------------
  //
  // (a) The named surface event, the carrier our own runner patches the pane
  // through (extension.js `updateSurface`).
  try {
    disposables.push(msty.surface.on("surface.updated", (/** @type {any} */ event) => onHostContextEvent(event, "surface.updated")));
  } catch {
    // host supports remount-only refresh
  }

  // (b) The catch-all surface event (d.ts:1419-1422). A chat-change event is not
  // contractually called `surface.updated`; a host that announces it under
  // another name (or re-emits the snapshot) is covered here, and a delivery that
  // changes nothing is a no-op.
  try {
    disposables.push(msty.surface.on("*", (/** @type {any} */ event) => onHostContextEvent(event, "surface.*")));
  } catch {
    // no catch-all on this host; the named events above still stand
  }

  // (c) The documented custom-UI event stream (d.ts:1277-1287, permission
  // `events.subscribe`). The stream is app-wide — composer typing, settings,
  // permissions — so only an event that NAMES a chat, or is NAMED like a chat
  // change, triggers a scope re-check; the rest are recorded as vocabulary
  // evidence and ignored. The subscription is never awaited: a frame that
  // blocked on it would never paint.
  try {
    if (typeof msty.events?.subscribe === "function") {
      const subscription = msty.events.subscribe((/** @type {any} */ event) => {
        const type = typeof event?.type === "string" ? event.type : "";
        const namedChatId = mountContextChatId(event?.data);
        if (!namedChatId && !CHAT_EVENT_NAME.test(type)) {
          recordHostContextEvent("events.subscribe", type);
          return;
        }
        onHostContextEvent({ type, data: event?.data }, "events.subscribe");
      });
      if (subscription && typeof subscription.then === "function") {
        subscription.then((/** @type {any} */ dispose) => disposables.push(dispose)).catch(() => {});
      } else {
        disposables.push(subscription);
      }
    }
  } catch {
    // no event stream on this host; the surface carriers above still stand
  }

  // (d) The last net: a host that announces nothing at all. The user's own flow
  // ends with them looking at the pane, so regaining focus re-checks which chat
  // is open. Cheap, and it makes the reported defect unreachable even on a host
  // that fires neither surface event nor extension event on a chat switch.
  try {
    const onWindowFocus = () => onHostContextEvent({}, "window.focus");
    window.addEventListener("focus", onWindowFocus);
    // Registered like every other carrier, so `pagehide` tears down all of them
    // (`disposables`) rather than leaving one listener behind (t_054750c9).
    disposables.push(() => window.removeEventListener("focus", onWindowFocus));
  } catch {
    // non-window frame; the subscribed carriers above are all that is available
  }

  try {
    if (typeof msty.surface?.on === "function") {
      const mountContext = msty.surface?.getSnapshot?.()?.context ?? msty.surface?.context ?? context;
      state.hasChat = mountContextHasChat(mountContext);
      state.chatId = mountContextChatId(mountContext) ?? state.chatId;
      renderHeaderHint();
      // The runner's open request carries the lifecycle phase (running at
      // auto-open time): absorb it so the first paint already shows progress.
      absorbLifecyclePush(parsePaneContext(mountContext));
    }
  } catch {
    // snapshot discovery is best-effort
  }

  // Initial paint: shell is already visible; history fills in async. Once it
  // settles the frame re-publishes its report (t_6c564822) so the instrument
  // describes a PAINTED pane — the sheets present, the marker resolved, the
  // action's real computed paint and box — instead of the empty shell the
  // mount-time report caught. Best-effort and never awaited: evidence, never a
  // render input.
  void (async () => {
    await refresh();
    publishCurrentThemeReport();
  })().catch(() => {});

  const onPageHide = () => {
    for (const dispose of disposables.splice(0)) {
      try {
        dispose?.();
      } catch {
        // a failing unsubscribe must not block the others
      }
    }
  };
  try {
    window.addEventListener("pagehide", onPageHide, { once: true });
  } catch {
    // non-window frame; nothing to clean up on page exit
  }

  return {
    /** Exposed for host introspection / tests; repaints from fresh storage. */
    refresh,
    /** Exposed for tests/introspection: re-resolves and re-applies the theme. */
    applyPaneTheme,
    /**
     * Exposed for tests/introspection: the report the frame last published for
     * `/hermes_review_diagnose` (t_5bffad26) — the same object written to
     * `storage.chat` under {@link THEME_REPORT_STORAGE_KEY}.
     */
    themeReport() {
      return buildPaneThemeReport({
        scheme: /** @type {any} */ (root)?.dataset?.rvScheme ?? null,
        hostScheme: readHostScheme(null),
        themeChangedFired: state.themeChangedFired,
        computed: readComputedThemeTokens(),
        tokens: readLiveThemeTokens(null),
        rendered: readRenderedFacts(),
        contextSync: {
          hostEvents: state.hostContextEvents,
          carriers: state.carriers,
          eventTypes: state.hostEventTypes,
          rescopes: state.rescopeCount,
          chatIds: state.rescopeChatIds,
          foreignPushes: state.foreignPushCount
        },
        at: new Date().toISOString()
      });
    }
  };
}
