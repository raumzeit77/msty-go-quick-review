// @ts-check

import {
  DIAGNOSTIC_FALLBACK_STAGE,
  REVIEWER_ASSIGNMENT_ID,
  ReviewStageError,
  boundFailureDetail,
  describeFailure,
  diagnosticMessage,
  executeReview,
  runDiagnosticStage,
  showToast
} from "./review-core.js";
import {
  appendReview,
  readReviewsNewestFirst,
  reportPersistenceFailure
} from "./review-history.js";
import { completionBlock } from "./review-core.js";
import {
  COPY,
  PANE_OPEN_COMMAND,
  PANE_POPUP_ID,
  PANE_THEME_PROBE_TOKENS,
  PANE_WORKSPACE_ID,
  THEME_REPORT_STORAGE_KEY,
  badgeText,
  buildPaneContext,
  buildPaneThemeReport,
  paneHeaderAction,
  paneToggleDecision,
  themeReportItems
} from "./review-pane.js";

const REVIEW_COMMAND = "hermes-review.run";
const OPEN_REVIEW_COMMAND = "hermes-review.open";
const DIAGNOSE_COMMAND = "hermes-review.diagnose";
const DIAGNOSE_SURFACE_ID = "hermes-review.diagnose";
const DIAGNOSE_SURFACE_TITLE = "Host diagnostics";
const DIAGNOSE_COMPAT = "^1.0.0";
const DIAGNOSE_STAGE_CAPABILITIES = "diagnose-capabilities";
const DIAGNOSE_STAGE_MODEL_STATUS = "diagnose-model-status";
const DIAGNOSE_STAGE_THEME = "diagnose-theme";

/** @param {unknown} value @returns {any} */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * True when the extension's current extensionApi compatibility range is
 * satisfied by the reported host API generation. Comparison is on the leading
 * major only; minor/patch ranges are treated as additive per contract guidance.
 * @param {unknown} hostVersion
 */
function compatSatisfied(hostVersion) {
  /** @param {unknown} value */
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
  };
  const wanted = parse(DIAGNOSE_COMPAT.replace(/^\^/, ""));
  const host = parse(hostVersion);
  if (!wanted || !host) return null;
  return host.major === wanted.major ? Math.max(0, host.minor - wanted.minor) : host.major - wanted.major;
}

/**
 * Reads the resolved reviewer-assignment status without assuming the model API
 * exists on older or degraded hosts.
 * @param {any} msty
 */
async function readReviewerStatus(msty) {
  if (typeof msty?.models?.getStatus !== "function") return { available: false, status: null };
  return { available: true, status: await msty.models.getStatus(REVIEWER_ASSIGNMENT_ID) };
}

/**
 * Documents the exact request the diagnostic seam accepts. Tests assert both
 * directions: this key set and the presence of every required key.
 * @param {any} msty
 * @param {string} surface "drawer" or "popup" for this render.
 * @param {{stage: string, detail: string, at: string}|null} [failure] the
 *        runtime's last failure (t_fa7ab623), or null when none was recorded.
 */
function diagnoseRequest(msty, surface, failure = null) {
  return { msty, surface, failure };
}

/**
 * Renders the host diagnostic report into the requested surface. This is the
 * single rendering seam for the probe: every open/patch call for the
 * diagnostics view funnels through this function, so card D can move the
 * surface kind here without touching the probe's data-collection logic.
 * Read-only and side-effect free apart from the surface render itself.
 * @param {any} msty
 * @param {{surface?: string, failure?: {stage: string, detail: string, at: string}|null}} request {@link diagnoseRequest}
 */
export async function renderSurface(msty, request) {
  const { msty: host, surface, failure } = diagnoseRequest(msty, request?.surface ?? "drawer", request?.failure ?? null);
  const { snapshot, reviewer } = await collectDiagnostics(host, failure);

  const content = [
    {
      type: "callout",
      title: "Host capability probe",
      body: `Extension ${String(snapshot.extension?.id ?? "(unknown id)")} on host extension API ${String(snapshot.extensionApiVersion ?? "(unreported)")}. Reviewer model: ${reviewer}.`
        + ` Copy this report when asking for support.`,
      tone: "info"
    },
    { type: "divider" },
    { type: "kv", title: "Host & API", items: snapshot.hostBlocks },
    { type: "divider" },
    { type: "kv", title: "Permissions", items: snapshot.permissionBlocks },
    { type: "divider" },
    { type: "kv", title: "Feature flags", items: snapshot.featureBlocks },
    { type: "divider" },
    { type: "kv", title: "Storage quotas", items: snapshot.storageBlocks },
    { type: "divider" },
    { type: "kv", title: "Model surfaces", items: snapshot.modelBlocks },
    { type: "divider" },
    { type: "kv", title: "Theme", items: snapshot.themeBlocks },
    { type: "divider" },
    { type: "kv", title: "Last failure", items: snapshot.failureBlocks }
  ];

  await patchDiagnoseSurface(host, surface, content);
}

/**
 * Opens or patches the diagnostics surface on the requested overlay kind.
 * Mirrors the review drawer's patch-then-open choreography: patch an
 * already-open surface first and open a fresh one when `updated` is false,
 * so the probe renders on a first native run and refreshes on re-runs.
 * Never awaited from the command site beyond this seam (guide:216-219).
 * @param {any} host
 * @param {string} surface
 * @param {any[]} content
 */
async function patchDiagnoseSurface(host, surface, content) {
  let patched = null;
  try {
    patched = await host.ui.updateSurface({
      id: DIAGNOSE_SURFACE_ID,
      kind: surface,
      title: DIAGNOSE_SURFACE_TITLE,
      content
    });
  } catch {
    patched = null;
  }
  if (patched && patched.updated) return;

  // Nothing open (or patch rejected): open the surface on the requested kind.
  const openRequest = {
    id: DIAGNOSE_SURFACE_ID,
    title: DIAGNOSE_SURFACE_TITLE,
    content,
    closeLabel: "Close"
  };
  if (surface === "popup") {
    void host.ui.openPopup(openRequest).catch(() => {});
  } else {
    void host.ui.openDrawer(openRequest).catch(() => {});
  }
}

/**
 * Collects the theme section of the diagnostic (t_5bffad26): what the host
 * actually hands a custom UI frame, which two rounds of this project could
 * only guess at.
 *
 * Two sources, both read-only:
 *  - the **pane frame report** the frame publishes into `storage.chat` on
 *    mount and on every `surface.themeChanged` — the frame is the only place
 *    the live theme is visible (computed token values via `getComputedStyle`,
 *    the host token payload, `colorScheme`, whether the theme event fired, and
 *    the `data-rv-scheme` the pane resolved);
 *  - the **runtime probe** for hosts that expose a `SurfaceTheme`-shaped API on
 *    the runtime side (`msty.theme.getTokens()` / `colorScheme`).
 *
 * Never throws: a host with none of these APIs (no `theme`, no `storage.chat`,
 * no report stored) still gets readable rows. Colours are not credentials, so
 * values are printed verbatim — no model key or provider identifier is ever
 * read here.
 * @param {any} msty
 * @returns {Promise<Array<{label: string, value: string}>>}
 */
async function collectThemeBlocks(msty) {
  const blocks = [];

  let stored = null;
  try {
    stored = await msty?.storage?.chat?.get?.(THEME_REPORT_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored && typeof stored === "object") {
    blocks.push(...themeReportItems(buildPaneThemeReport(stored)));
  } else {
    blocks.push({
      label: "pane frame report",
      value: `unavailable (no report stored — open the pane, then re-run; diagnostic-stage=${DIAGNOSE_STAGE_THEME})`
    });
  }

  let runtimeTokens = null;
  try {
    const payload = msty?.theme?.getTokens?.();
    if (payload && typeof payload === "object") runtimeTokens = payload;
  } catch {
    runtimeTokens = null;
  }
  let runtimeScheme = null;
  try {
    const reported = msty?.theme?.colorScheme;
    runtimeScheme = typeof reported === "string" && reported.trim() ? reported.trim() : null;
  } catch {
    runtimeScheme = null;
  }
  blocks.push({
    label: "runtime theme API",
    value: runtimeTokens || runtimeScheme
      ? "present"
      : `unavailable (diagnostic-stage=${DIAGNOSE_STAGE_THEME})`
  });
  blocks.push({ label: "runtime colorScheme", value: runtimeScheme ?? "(unreported)" });
  for (const name of PANE_THEME_PROBE_TOKENS) {
    const value = runtimeTokens ? runtimeTokens[name] : undefined;
    blocks.push({
      label: `runtime theme.getTokens() ${name}`,
      value: typeof value === "string" && value.trim() ? value.trim() : "(absent)"
    });
  }
  return blocks;
}

/**
 * Collects the live host contract snapshot used by the diagnostics render.
 * Never throws: degraded hosts produce degraded blocks, not failures.
 * `failure` is the runtime's last recorded failure (t_fa7ab623) — stage token
 * plus the bounded, credential-free reason it preserved. Both strings are
 * re-bounded here so the report can never grow past the detail contract.
 * @param {any} msty
 * @param {{stage?: unknown, detail?: unknown, at?: unknown}|null} [failure]
 */
async function collectDiagnostics(msty, failure = null) {
  const hostBlocks = [];
  const permissionBlocks = [];
  const featureBlocks = [];
  const storageBlocks = [];
  const modelBlocks = [];
  const failureBlocks = [];
  const themeBlocks = [];

  let snapshot = null;
  try {
    snapshot = await msty.platform.getCapabilities();
  } catch {
    permissionBlocks.push({
      label: "getCapabilities",
      value: `unavailable (diagnostic-stage=${DIAGNOSE_STAGE_CAPABILITIES})`
    });
  }

  if (snapshot) {
    const compatDelta = compatSatisfied(snapshot.extensionApiVersion);
    hostBlocks.push(
      { label: "Extension API version", value: String(snapshot.extensionApiVersion ?? "(unreported)") },
      { label: "Compatibility " + DIAGNOSE_COMPAT, value: compatDelta === null ? "unknown" : compatDelta >= 0 ? "satisfied" : "behind" },
      { label: "Manifest version", value: String(snapshot.manifestVersion ?? "(unreported)") },
      { label: "Trust level", value: String(snapshot.extension?.trustLevel ?? "(unreported)") },
      { label: "Enabled", value: String(snapshot.extension?.enabled ?? "(unreported)") }
    );

    const groups = asObject(snapshot.permissions) ?? {};
    for (const [state, ids] of Object.entries(groups)) {
      if (!["granted", "pending", "denied"].includes(state)) continue;
      permissionBlocks.push({ label: state, value: Array.isArray(ids) && ids.length ? ids.join(", ") : "(none)" });
    }
    for (const state of ["revoked", "unavailable"]) {
      const ids = groups[state];
      if (Array.isArray(ids) && ids.length) {
        permissionBlocks.push({ label: state, value: ids.join(", ") });
      }
    }

    const surfaces = asObject(snapshot.surfaces) ?? {};
    for (const [surfaceName, capability] of Object.entries(surfaces)) {
      const cap = asObject(capability);
      if (!cap) continue;
      permissionBlocks.push({
        label: `surface ${surfaceName}`,
        value: `${cap.canUse === true ? "usable" : "blocked"} (permission ${String(cap.permission ?? "(unreported)")}, state ${String(cap.state ?? "(unreported)")}, declared ${String(cap.declaredCount ?? 0)})`
      });
    }

    const features = asObject(snapshot.features) ?? {};
    for (const [flag, value] of Object.entries(features)) {
      featureBlocks.push({ label: `features.${flag}`, value: String(value) });
    }

    const storage = asObject(snapshot.storage) ?? {};
    const scopeLabels = { local: "storage.local", chat: "storage.chat", workspace: "storage.workspace" };
    for (const [scope, cap] of Object.entries(storage)) {
      const capability = asObject(cap);
      if (!capability) continue;
      const maxValue = capability.maxValueBytes;
      const maxScope = capability.maxScopeBytes;
      storageBlocks.push({
        label: scopeLabels[scope] ?? scope,
        value: capability.canUse === false
          ? "unusable"
          : `max value ${formatBytes(maxValue)}, max scope ${formatBytes(maxScope)}${capability.migrations ? ", migrations" : ""}`
      });
    }

    const models = asObject(snapshot.models) ?? {};
    modelBlocks.push(
      { label: "canInfer", value: String(models.canInfer ?? "(unreported)") },
      { label: "declared assignments", value: String(models.declaredAssignmentCount ?? "(unreported)") }
    );
  } else {
    hostBlocks.push({ label: "Extension API version", value: "(unavailable)" });
    featureBlocks.push({ label: "features", value: "unavailable (no capability snapshot)" });
    storageBlocks.push({ label: "quotas", value: "unavailable (no capability snapshot)" });
    modelBlocks.push({ label: "model surfaces", value: "unavailable (no capability snapshot)" });
  }

  // Last recorded failure (t_fa7ab623): the stage token stays the designed
  // surface; the reason rides beside it so a host-only failure is reportable.
  failureBlocks.push(
    { label: "stage", value: boundFailureDetail(String(failure?.stage ?? "")) ?? "(none recorded)" },
    { label: "reason", value: boundFailureDetail(String(failure?.detail ?? "")) ?? "(none recorded)" },
    { label: "at", value: boundFailureDetail(String(failure?.at ?? "")) ?? "(none recorded)" }
  );

  // Theme truth (t_5bffad26): the frame report the pane published, plus the
  // runtime-side theme API when this host exposes one. Diagnostic only.
  try {
    themeBlocks.push(...(await collectThemeBlocks(msty)));
  } catch {
    themeBlocks.push({
      label: "theme probe",
      value: `unavailable (diagnostic-stage=${DIAGNOSE_STAGE_THEME})`
    });
  }

  let reviewer = "status unavailable";
  try {
    const { available, status } = await readReviewerStatus(msty);
    if (available) {
      reviewer = status?.ready === true && status?.configured === true
        ? "assigned and ready"
        : status?.configured === true
          ? "configured but not ready"
          : "not configured (main model fallback)";
    } else {
      reviewer = "models.getStatus unavailable on this host";
    }
  } catch {
    reviewer = `unavailable (diagnostic-stage=${DIAGNOSE_STAGE_MODEL_STATUS})`;
  }

  return {
    snapshot: {
      extensionApiVersion: snapshot?.extensionApiVersion,
      extension: snapshot?.extension,
      manifestVersion: snapshot?.manifestVersion,
      hostBlocks,
      permissionBlocks,
      featureBlocks,
      storageBlocks,
      modelBlocks,
      themeBlocks,
      failureBlocks
    },
    reviewer
  };
}

/** @param {unknown} value */
function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "(unreported)";
  if (numeric >= 1024 * 1024) return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
  if (numeric >= 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  return `${numeric} B`;
}

/** @param {import("@msty/extension-api").ExtensionApi} msty */
export async function activate(msty) {
    let running = false;
    /** Open-popup promise: the ONLY liveness signal for open-vs-toggle-close. */
    let paneOpenPromise = null;
    /** Number of stored reviews for the active chat (drives the launcher badge). */
    let badgeCount = 0;
    /**
     * True while a pane surface opened by this runtime is believed live. Set
     * when the open request fires and cleared when the open promise settles
     * (user dismissal, host close, or toggle-close). Gates the lifecycle
     * patches ONLY — it never blocks re-opening: open-vs-close is decided by
     * `paneOpenPromise` alone, so a dismissed pane re-opens on the next run.
     */
    let paneSurfaceOpen = false;
    /**
     * Last recorded review failure for THIS runtime (t_fa7ab623): the bounded
     * reason the diagnostic wrapper preserved. Read by `/hermes_review_diagnose`
     * so a failure observed in a native session stays reportable.
     * @type {{stage: string, detail: string, at: string}|null}
     */
    let lastFailure = null;

    // Bootstrap badge count: a side-effect-free read. Activation never writes
    // chat storage — the history module's persisting path belongs to the
    // write paths (append/delete/clear) and to the pane's own first read, so
    // a fresh chat stays untouched until the user actually reviews or opens
    // the pane. Best-effort; the review flow never depends on it. Per-chat
    // history is keyed per chat, and activation resolves no chat id (the
    // diagnostic contract pins exactly one context read per run), so this
    // read is unattributed by design and returns an empty list; the badge is
    // corrected on the first run and by the pane's own refresh.
    try {
      badgeCount = (await readReviewsNewestFirst(msty, null)).length;
    } catch {
      // History is an enhancement; the review flow never depends on it.
    }

    /** @param {number} count */
    async function updateBadge(count) {
      badgeCount = count;
      try {
        msty.ui.update({
          id: "hermes-review-titlebar",
          surface: "titleBar",
          badge: badgeText(count) || null
        });
      } catch {
        // badge chrome is cosmetic; older hosts may not support ui.update
      }
    }

    /**
     * Opens the review pane on its DECLARED contribution. Never awaited from a
     * command handler: the open promise resolves when the user closes the
     * surface (guide:216-219). The open request carries the canonical trash
     * header action (conventions §6) and the runner's current lifecycle phase
     * context (conventions §7), so the frame renders progress from the very
     * first mount. Falls back to openPopup for older hosts.
     *
     * t_9622dfc8 item B: the request is made by the manifest-declared
     * contribution ID and carries NO `kind`. The guide prefers opening a declared
     * dialog/drawer/popup/fullView by its contribution ID, and `kind` is optional
     * when that ID is unique across the declared overlays (guide:1098-1122) — the
     * manifest stays the source of truth for the title, entry file and default
     * size. The pane's popup is declared with its own title/entry/command/size,
     * so the host resolves the surface from the same contribution Side Chat
     * resolves its popup from. (Whether that stops the host composing its hover
     * caption can only be settled by the user's smoke — see the release record.)
     * @param {{phase: string, instruction?: string, completionBody?: string, failureStage?: string, failureDetail?: string}} [phase]
     * @returns {Promise<any> | null} the open promise, when one was started
     */
    function openPaneSurface(phase = { phase: "idle" }) {
      if (paneOpenPromise) return paneOpenPromise;
      const openRequest = {
        id: PANE_POPUP_ID,
        headerActions: [paneHeaderAction()],
        context: buildPaneContext(phase),
        // Side Chat pattern (d.ts:1578, conventions §4): keep the active chat
        // merged into the surface context on open and chat changes, so the
        // frame re-scopes its per-chat history list on switches.
        contextSync: { activeChat: true }
      };
      let openPromise;
      try {
        openPromise = msty.ui.openContribution(openRequest);
      } catch {
        openPromise = null;
      }
      if (!openPromise || typeof openPromise.then !== "function") {
        // Older hosts: openPopup(title) style open. Hosts without either API
        // surface simply do not get auto-open; the slash command still works.
        try {
          openPromise = msty.ui.openPopup?.({ id: PANE_POPUP_ID, title: COPY.panelTitle, closeLabel: "Close" }) ?? null;
        } catch {
          openPromise = null;
        }
      }
      paneOpenPromise = Promise.resolve(openPromise)
        .then(() => {})
        .catch(() => {})
        .finally(() => {
          paneOpenPromise = null;
          // The open promise settles when the surface is dismissed/closed:
          // lifecycle patches must stop targeting it, but the NEXT open must
          // still fire (open-vs-close is decided by paneOpenPromise alone).
          paneSurfaceOpen = false;
        });
      paneSurfaceOpen = true;
      return paneOpenPromise;
    }

    /**
     * Pushes a lifecycle phase onto the pane surface (conventions §7). The
     * patch targets the popup by id+kind; a rejection (pane closed before the
     * patch lands, older hosts) is silently tolerated — toasts remain the
     * guaranteed channel either way.
     * @param {{phase: string, chatId?: string, instruction?: string, completionBody?: string, failureStage?: string, failureDetail?: string}} phase
     */
    async function patchPaneContext(phase) {
      if (!paneSurfaceOpen) return;
      try {
        await msty.ui.updateSurface({
          kind: "popup",
          id: PANE_POPUP_ID,
          context: buildPaneContext(phase)
        });
      } catch {
        // The pane surface is the enhancement; the toast chain is the
        // guaranteed channel. A lost patch never fails the review.
      }
    }

    /**
     * Toggle choreography (mirrors Side Chat): the open promise is the ONLY
     * open/close signal. While it is live a second invocation closes the
     * surface — and `closed: false` from the host means the host lost the
     * popup, so the guard resets and the pane reopens. Once the promise has
     * settled (user dismissal, toggle close, or a legacy/synthetic host that
     * resolves immediately) the next invocation simply opens a fresh surface;
     * lifecycle patches target only the surface this runtime still believes
     * open (`paneSurfaceOpen`).
     * @param {{phase: string, chatId?: string, instruction?: string, completionBody?: string, failureStage?: string, failureDetail?: string}} [phase]
     * @param {{allowToggleClose?: boolean}} [options] launcher/hotkey
     *        invocations toggle-close an open pane (design §5 Toggle); the
     *        runner's auto-open never closes a visible pane — `/review` while
     *        the pane is up only re-surfaces its current phase.
     */
    async function openPane(phase = { phase: "idle" }, options = {}) {
      /** @type {{phase: string, chatId?: string, instruction?: string, completionBody?: string, failureStage?: string, failureDetail?: string}} */
      const openPhase = phase ?? { phase: "idle" };
      const allowToggleClose = options.allowToggleClose !== false;
      if (paneOpenPromise) {
        if (!allowToggleClose) {
          // Runner auto-open with the pane already up: keep the surface,
          // re-point its phase. Never toggles the progress pane closed.
          await patchPaneContext(openPhase);
          return { action: "surface" };
        }
        let result = null;
        try {
          result = await msty.ui.closeSurface({ kind: "popup", id: PANE_POPUP_ID, result: { dismissed: true } });
        } catch {
          result = null;
        }
        paneOpenPromise = null;
        paneSurfaceOpen = false;
        const decision = paneToggleDecision({ paneOpen: true }, result);
        if (decision.action === "reopen") openPaneSurface();
        return decision;
      }
      // No live open promise (never opened, or the surface was dismissed /
      // toggle-closed): open a fresh surface carrying the current phase. The
      // dismissed-pane case is exactly design §5's reopen rule — a runner that
      // opens with `phase: "running"` re-mounts the frame into progress.
      openPaneSurface(openPhase);
      return paneToggleDecision({ paneOpen: false }, null);
    }

    msty.commands.register({
      id: "hermes-review.open",
      label: "Open latest independent review",
      command: OPEN_REVIEW_COMMAND
    });

    // The workspace launcher is optional chrome. Older hosts may expose the
    // API contract without supporting this registration at runtime. Never let
    // it prevent the core slash command from activating. It is re-pointed to
    // open the popup pane (same surface as the title-bar launcher).
    try {
      msty.ui.registerWorkspaceItem({
        id: PANE_WORKSPACE_ID,
        title: COPY.panelTitle,
        label: COPY.launcherLabel,
        tooltip: COPY.launcherTooltip,
        icon: "static/icon.svg",
        command: PANE_OPEN_COMMAND
      });
    } catch {
      // /review and the internal reopen command remain available.
    }

    async function runReview(args = "") {
      if (running) {
        // Never toggle-close the progress pane while a review runs: re-surface
        // the running phase instead (design §5:104 — the user's repeated
        // /review must not close the pane showing their running review).
        await patchPaneContext({ phase: "running", instruction: typeof args === "string" ? args : "" });
        return;
      }

      running = true;
      /** Instruction for this run; carried into every lifecycle context push. */
      const instruction = typeof args === "string" ? args : "";
      try {
        try {
          const draft = await msty.composer.get();
          if (draft.text.trim().startsWith("/review")) await msty.composer.clear();
        } catch {
          // Do not fail the review if the command draft cannot be cleared.
        }

        // Auto-open: the pane is the progress surface. The open request itself
        // carries the running phase, so the frame mounts straight into
        // progress; the runner never depends on the pane mounting.
        try {
          await openPane({ phase: "running", instruction }, { allowToggleClose: false });
        } catch {
          // The review completes and persists even when the pane never opens.
        }

        await showToast(msty, {
          title: COPY.toastReviewStarted,
          tone: "default",
          durationMs: 4000
        });

        const outcome = await executeReview(msty, instruction);
        if (!outcome.ok) throw new ReviewStageError(outcome.stage, outcome.cause ?? null, { detail: outcome.detail });
        const { review, meta } = outcome;

        // Per-chat history. The review outcome already carries the chat id it
        // ran in (executeReview resolves it from the host context), so the
        // entry is attributed to the producing chat — never to a foreign
        // document's claim. Silent when the host predates storage.chat; one
        // concise toast with the bare stage token when a write is rejected
        // even after the prune-and-retry, so no review is lost silently.
        let historyPersisted = false;
        try {
          const appended = await appendReview(msty, review, meta, outcome.chatId);
          historyPersisted = appended.persisted === true;
          if (appended.persisted === false && appended.unavailable !== true) {
            await reportPersistenceFailure(msty);
          }
        } catch {
          await reportPersistenceFailure(msty);
        }
        await updateBadge(historyPersisted ? badgeCount + 1 : badgeCount);

        // Completion phase: the frame swaps the running row for the
        // completion callout (`Reviewed N recent messages.` — model-free pane
        // copy, t_0025dae6; the run's model provenance stays on the history
        // entry, never in copy).
        await patchPaneContext({
          phase: "complete",
          chatId: outcome.chatId,
          completionBody: completionBlock(meta.messageCount).body
        });

        await runDiagnosticStage(
          "completion-notification",
          () => showToast(msty, {
            title: "Independent review complete",
            tone: "success",
            durationMs: 4000
          })
        );
      } catch (error) {
        const failureStage = error instanceof ReviewStageError ? error.stage : DIAGNOSTIC_FALLBACK_STAGE;
        // t_fa7ab623: the reason is no longer destroyed here. It rides beside
        // the token into the pane's failure callout and is kept for the
        // diagnostics report, so a host-only failure is diagnosable without a
        // code change. The toast keeps the bare token (contract, unchanged).
        const failureDetail = error instanceof ReviewStageError && typeof error.detail === "string"
          ? error.detail
          : describeFailure(error);
        lastFailure = { stage: failureStage, detail: failureDetail, at: new Date().toISOString() };
        // The pane renders the failure callout + Retry when it is open; the
        // toast carries the bare stage token either way (never the wording).
        await patchPaneContext({ phase: "failed", instruction, failureStage, failureDetail });
        await showToast(msty, {
          title: "Review failed",
          body: `diagnostic-stage=${failureStage}`,
          tone: "error",
          durationMs: 6000
        });
      } finally {
        running = false;
      }
    }

    const run = async (command, payload, ...args) => {
      void args;
      if (command === REVIEW_COMMAND) {
        return runReview(typeof payload === "string" ? payload : "");
      }
      if (command === PANE_OPEN_COMMAND || command === OPEN_REVIEW_COMMAND) {
        return openPane();
      }
      if (command === DIAGNOSE_COMMAND) {
        // Read-only probe: render the live host contract through the single
        // diagnostics seam, now on the popup overlay. Payload is intentionally
        // unused beyond compatibility. The runtime's last failure is included
        // so a native failure is reportable without a code change (t_fa7ab623).
        void payload;
        await renderSurface(msty, { surface: "popup", failure: lastFailure });
        return {
          message: "Host diagnostics opened.",
          metadata: { command: DIAGNOSE_COMMAND, readOnly: true }
        };
      }
      throw new Error(`Unknown command: ${command}`);
    };

    return { run };
  }

export default { activate };
