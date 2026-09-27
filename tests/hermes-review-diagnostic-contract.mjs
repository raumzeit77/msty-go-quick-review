import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../hermes-review-extension/extension.js";
import {
  FAILURE_DETAIL_MAX_LENGTH,
  ReviewStageError,
  describeFailure,
  runDiagnosticStage
} from "../hermes-review-extension/review-core.js";
import { THEME_REPORT_STORAGE_KEY } from "../hermes-review-extension/review-pane.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "hermes-review-extension");
const ENTRY_PATH = path.join(PACKAGE_ROOT, "extension.js");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.json");
const LIFECYCLE_HARNESS_PATH = path.join(TEST_DIR, "hermes-review-lifecycle-contract.mjs");
const EXISTING_HARNESS_PATH = path.join(TEST_DIR, "hermes-review-contract.mjs");
const DIAGNOSTIC_HARNESS_PATH = path.join(TEST_DIR, "hermes-review-diagnostic-contract.mjs");
const REVIEW_COMMAND = "hermes-review.run";
const DIAGNOSE_COMMAND = "hermes-review.diagnose";
const FAILURE_REPORT_ID = "hermes-review.diagnose";
const DEADLINE_MS = 1_000;
const STRUCTURED_REVIEW = { summary: "No material issues found.", issues: [] };

// These are the only telemetry identifiers accepted by this contract.
// Card D re-scopes the boundary set to the live review path: the drawer's
// `completed-surface-update` patch boundary is gone (failure visibility moved
// into the pane + toast), and history persistence rejects carry the
// `history-persistence` stage from the shared history module.
// Rework t_464e32ac re-pins the surface failure channel to the runner's
// `failed` lifecycle context push (open request / updateSurface patch), so
// the callout channel is required again (requireCallout: true).
const STAGE_IDS = Object.freeze([
  "current-chat-lookup",
  "recent-message-retrieval",
  "model-assignment-status",
  "inference-request",
  "response-normalization",
  "history-persistence",
  "completion-notification"
]);
const STAGE_SET = new Set([...STAGE_IDS, "review-workflow", "persistence-storage"]);
const STAGE_MARKER = /diagnostic-stage=([a-z0-9-]+)/g;

// Pane choreography (card D): the drawer content patches are gone. Each run
// auto-opens the popup pane exactly once (counted under `opens`), and the
// launcher badge is updated via ui.update exactly when persistence succeeded
// (counted under `updates`). `storage` counts attempted writes; on the
// history-persistence stage the first write is rejected and the prune retry
// fires, so both the attempt count and the injection count are 2.
const STAGE_SPECS = Object.freeze({
  "current-chat-lookup": { current: 1, messages: 0, assignment: 0, infer: 0, storage: 0, opens: 1, updates: 0, notifications: 2, injections: 1 },
  "recent-message-retrieval": { current: 1, messages: 1, assignment: 0, infer: 0, storage: 0, opens: 1, updates: 0, notifications: 2, injections: 1 },
  "model-assignment-status": { current: 1, messages: 1, assignment: 1, infer: 0, storage: 0, opens: 1, updates: 0, notifications: 2, injections: 1 },
  "inference-request": { current: 1, messages: 1, assignment: 1, infer: 1, storage: 0, opens: 1, updates: 0, notifications: 2, injections: 1 },
  "response-normalization": { current: 1, messages: 1, assignment: 1, infer: 1, storage: 0, opens: 1, updates: 0, notifications: 2, injections: 1 },
  "history-persistence": { current: 1, messages: 1, assignment: 1, infer: 1, storage: 2, opens: 1, updates: 1, notifications: 3, injections: 2 },
  "completion-notification": { current: 1, messages: 1, assignment: 1, infer: 1, storage: 1, opens: 1, updates: 1, notifications: 3, injections: 1 }
});

class DesignedRedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DesignedRedError";
  }
}

class DeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeadlineError";
  }
}

function withDeadline(value, label, milliseconds = DEADLINE_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${milliseconds} ms deadline`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function outputSignature(value) {
  if (typeof value === "string") return `string:${value}`;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? typeof value : `json:${serialized}`;
  } catch {
    return `unserializable:${Object.prototype.toString.call(value)}`;
  }
}

function stageMarkers(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(STAGE_MARKER)].map((match) => match[1]);
}

function createNormalizationFailure() {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`wo009 normalization probe ${String(property)}`);
    },
    ownKeys() {
      throw new Error("wo009 normalization probe keys");
    },
    getOwnPropertyDescriptor() {
      throw new Error("wo009 normalization probe descriptor");
    }
  });
}

function assertExactKeys(value, allowed, label) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  assert.deepEqual(unexpected, [], `${label} contains undocumented fields: ${unexpected.join(", ")}`);
}

function assertContent(content, label) {
  assert.equal(Array.isArray(content), true, `${label} content must be an array`);
  for (const [index, block] of content.entries()) {
    assert.equal(typeof block?.type, "string", `${label} block ${index} type`);
    if (block.type === "callout") {
      assertExactKeys(block, ["type", "title", "body", "tone"], `${label} callout ${index}`);
      assert.equal(typeof block.body, "string", `${label} callout ${index} body`);
    } else if (block.type === "text") {
      assertExactKeys(block, ["type", "text", "title", "tone"], `${label} text ${index}`);
      assert.equal(typeof block.text, "string", `${label} text ${index} text`);
    } else if (block.type === "progress") {
      assertExactKeys(block, ["type", "title", "label", "value", "max", "description", "tone"], `${label} progress ${index}`);
      assert.equal(typeof block.value, "number", `${label} progress ${index} value`);
    } else {
      assert.equal(block.type, "divider", `${label} unsupported block type ${block.type}`);
      assertExactKeys(block, ["type"], `${label} divider ${index}`);
    }
  }
}

function assertUiRequest(request, label, { patch = false } = {}) {
  const allowed = patch
    ? ["id", "kind", "title", "width", "content", "actions", "closeLabel", "body"]
    : ["id", "title", "width", "content", "actions", "closeLabel", "body"];
  assertExactKeys(request, allowed, label);
  assert.equal(typeof request.id, "string", `${label} id`);
  if (patch) assert.equal(request.kind, "drawer", `${label} kind`);
  if (request.content !== undefined && request.content !== null) assertContent(request.content, label);
  if (request.actions !== undefined && request.actions !== null) {
    assert.equal(Array.isArray(request.actions), true, `${label} actions`);
    for (const action of request.actions) assertExactKeys(action, ["id", "label", "variant"], `${label} action`);
  }
}

function assertNotification(request, label) {
  assertExactKeys(request, ["title", "body", "tone", "durationMs"], label);
  assert.equal(typeof request.title, "string", `${label} title`);
  assert.equal(typeof request.body === "undefined" || typeof request.body === "string", true, `${label} body`);
  assert.equal(["default", "success", "warning", "error", undefined].includes(request.tone), true, `${label} tone`);
}

function assertListRequest(request) {
  assertExactKeys(request, ["chatId", "limit", "order"], "messages.list request");
  assert.equal(typeof request.chatId, "string", "messages.list chatId");
  assert.equal(request.order, "desc", "messages.list order");
}

function assertInferenceRequest(request) {
  assertExactKeys(request, ["messages", "modelAssignment", "responseFormat"], "models.infer request");
  assert.deepEqual(request.messages.map((message) => message.role), ["system", "user"], "models.infer roles");
  assert.equal(request.modelAssignment === undefined || request.modelAssignment === "reviewer", true, "models.infer assignment");
  assert.equal(request.responseFormat.type, "json", "models.infer responseFormat type");
}

function createReviewerStatus(options = {}) {
  return {
    ready: true,
    configured: true,
    source: "assignment",
    modelAssignment: "reviewer",
    ...options.reviewerStatus
  };
}

function createController(options, calls) {
  const controller = {
    runNumber: 0,
    inject(stage) {
      if (options.failureStage !== stage || controller.runNumber !== 1) return false;
      calls.injections.push(stage);
      return true;
    },
    failureValue() {
      if (typeof options.failureValueFactory === "function") return options.failureValueFactory();
      return options.failureValue;
    }
  };
  return controller;
}

function createHost(options = {}) {
  const events = [];
  const calls = {
    events,
    notifications: [],
    notificationAttempts: [],
    lists: [],
    infer: [],
    inferAttempts: [],
    modelAssignments: [],
    opened: [],
    updateAttempts: [],
    emittedUpdates: [],
    chromeUpdates: [],
    composerSet: [],
    composerGets: 0,
    composerClear: 0,
    storageAttempts: [],
    storageSets: [],
    workspaceItems: [],
    injections: []
  };
  const stored = new Map();
  const chatStored = new Map();
  const controller = createController(options, calls);

  const msty = {
    context: {
      async getCurrentChat() {
        events.push("context.current");
        if (controller.inject("current-chat-lookup")) throw controller.failureValue();
        return options.currentChat ?? { chat: { id: "wo009-current-chat" }, messages: [] };
      }
    },
    commands: {
      register(registration) {
        assertExactKeys(registration, ["id", "label", "description", "command", "name", "slashName", "argumentHint", "priority"], "commands.register registration");
        assert.equal(typeof registration.id, "string", "commands.register id");
        assert.equal(typeof registration.label, "string", "commands.register label");
        assert.equal(typeof registration.command, "string", "commands.register command");
        events.push(`register:${registration.command}`);
        return () => {};
      }
    },
    messages: {
      async list(request) {
        assertListRequest(request);
        events.push("messages.list");
        calls.lists.push(request);
        if (controller.inject("recent-message-retrieval")) throw controller.failureValue();
        return options.messages ?? [{ id: "wo009-message-1", role: "user", content: "wo009-normal-transcript" }];
      }
    },
    models: {
      async getStatus(request) {
        assert.equal(request, "reviewer", "models.getStatus must inspect the contributed reviewer assignment");
        events.push("models.getStatus");
        calls.modelAssignments.push("reviewer");
        if (controller.inject("model-assignment-status")) throw controller.failureValue();
        return createReviewerStatus(options);
      },
      async infer(request) {
        assertInferenceRequest(request);
        events.push("models.infer");
        calls.inferAttempts.push(request);
        calls.infer.push(request);
        if (controller.inject("inference-request")) throw controller.failureValue();
        if (controller.inject("response-normalization")) return { text: "", json: createNormalizationFailure() };
        const result = options.inferContent ?? STRUCTURED_REVIEW;
        return options.inferTextOnly
          ? { text: JSON.stringify(result) }
          : { text: JSON.stringify(result), json: result };
      }
    },
    notifications: {
      async show(request) {
        assertNotification(request, "notifications.show request");
        events.push(`notification:${request.tone}:${request.title}`);
        calls.notificationAttempts.push(request);
        if (
          request.title === "Independent review complete" &&
          controller.inject("completion-notification")
        ) {
          throw controller.failureValue();
        }
        calls.notifications.push(request);
      }
    },
    composer: {
      async get() {
        events.push("composer.get");
        calls.composerGets += 1;
        return { text: options.composerText ?? "/review", canEdit: true };
      },
      async clear() {
        events.push("composer.clear");
        calls.composerClear += 1;
      },
      async setText(text) {
        events.push("composer.setText");
        calls.composerSet.push(text);
      }
    },
    storage: {
      local: {
        async get(key) {
          events.push(`storage.get:${key}`);
          return stored.get(key);
        },
        async set(key, value) {
          events.push(`storage.set:${key}`);
          calls.storageAttempts.push({ key, value });
          if (controller.inject("persistence-storage")) throw controller.failureValue();
          stored.set(key, value);
          calls.storageSets.push({ key, value });
        }
      },
      chat: {
        async get(key) {
          events.push(`storage.chat.get:${key}`);
          return chatStored.get(key);
        },
        async set(key, value) {
          events.push(`storage.chat.set:${key}`);
          calls.storageAttempts.push({ key, value, scope: "chat" });
          if (controller.inject("persistence-storage") || controller.inject("history-persistence")) throw controller.failureValue();
          chatStored.set(key, value);
          calls.storageSets.push({ key, value, scope: "chat" });
        }
      }
    },
    ui: {
      registerWorkspaceItem(item) {
        assertExactKeys(item, ["id", "title", "label", "description", "icon", "when", "command", "tooltip", "surface", "priority"], "ui.registerWorkspaceItem registration");
        events.push("ui.registerWorkspaceItem");
        calls.workspaceItems.push(item);
      },
      openContribution(request) {
        assertExactKeys(request, ["id", "title", "body", "content", "closeLabel", "context", "contextSync", "headerActions"], "ui.openContribution request");
        // t_9622dfc8 item B: opened by the declared contribution id, without kind.
        assert.equal("kind" in request, false, "ui.openContribution opens the declared contribution without kind");
        assert.equal(request.id, "hermes-review-pane", "ui.openContribution id targets the pane contribution");
        events.push("ui.openContribution");
        calls.opened.push(request);
        // Real-host semantics (Side Chat pattern, matches the lifecycle
        // harness): the open promise stays pending while the user keeps the
        // popup open. An immediately-resolved promise models an already-
        // closed surface — the runner would (correctly) stop pushing lifecycle
        // patches to it, which is not the scenario this suite exercises.
        return new Promise(() => {});
      },
      async update(request) {
        assertExactKeys(request, ["id", "surface", "badge", "tone", "hidden", "disabled", "disabledReason", "tooltip", "summary", "detail", "actionLabel", "shortcut", "shortcutHint"], "ui.update request");
        assert.equal(request.surface, "titleBar", "ui.update surface");
        events.push("ui.update");
        calls.chromeUpdates.push(request);
      },
      async updateSurface(request) {
        assertExactKeys(request, ["id", "kind", "title", "content", "context", "headerActions"], "diagnose updateSurface request");
        events.push(`ui.updateSurface:${request.content?.[0]?.title ?? request.context?.review?.phase ?? "untitled"}`);
        calls.updateAttempts.push(request);
        if (controller.inject("completed-surface-update")) throw controller.failureValue();
        calls.emittedUpdates.push(request);
        return { updated: options.surfaceUpdated ?? true, id: request.id, kind: request.kind };
      }
    }
  };

  return { msty, calls, controller };
}

function failureOptions(stage, overrides = {}) {
  const options = {
    failureStage: stage,
    failureValue: new Error("wo009 injected boundary failure"),
    ...overrides
  };
  return options;
}

async function activateHost(options = {}) {
  const host = createHost(options);
  const runtime = await withDeadline(extension.activate(host.msty), "extension activation");
  assert.equal(typeof runtime?.run, "function", "diagnostic harness requires the documented returned runtime");
  const originalRun = runtime.run;
  runtime.run = (...args) => {
    host.controller.runNumber += 1;
    return originalRun(...args);
  };
  return { ...host, runtime };
}

async function invoke(host, args = "") {
  await withDeadline(host.runtime.run(REVIEW_COMMAND, args), "diagnostic review invocation");
}

function traceCounts(calls) {
  return {
    current: calls.events.filter((event) => event === "context.current").length,
    messages: calls.lists.length,
    assignment: calls.modelAssignments.filter((slot) => slot === "reviewer").length,
    infer: calls.inferAttempts.length,
    storage: calls.storageAttempts.length,
    opens: calls.opened.length,
    updates: calls.chromeUpdates.length,
    notifications: calls.notificationAttempts.length,
    injections: calls.injections.length
  };
}

function assertStageTrace(host, stage) {
  const expected = STAGE_SPECS[stage];
  assert.deepEqual(traceCounts(host.calls), expected, `${stage} must fail at its injected boundary without skipping or adding a later boundary`);
  assert.deepEqual(
    host.calls.injections,
    Array.from({ length: expected.injections }, () => stage),
    `${stage} injection must be genuinely exercised at the expected boundary`
  );
}

function calloutBlocks(requests) {
  // Rework t_464e32ac: the failure callout channel is the runner's `failed`
  // lifecycle context push (open request / updateSurface patch), not a
  // host-managed content block. Each entry's "text" is the stage token string.
  return requests
    .filter((request) => request?.context?.review?.phase === "failed")
    .map((request) => ({ title: "Review failed", body: `diagnostic-stage=${request.context.review.failureStage ?? ""}` }));
}

/**
 * The bounded reason carried by the runner's `failed` lifecycle context push
 * (t_fa7ab623). This is the channel the pane renders as its details line.
 * @param {any} calls
 */
function failedPushDetail(calls) {
  const push = calls.emittedUpdates.concat(calls.opened)
    .find((request) => request?.context?.review?.phase === "failed");
  return push ? push.context.review.failureDetail : undefined;
}

/**
 * t_fa7ab623: a failing stage must report WHY, not only which stage broke. The
 * injected cause message is the fixture that proves the reason survives — each
 * stage's fixture is the one its boundary actually throws.
 * @param {string} stage @param {any} calls
 */
function failureReasonViolations(stage, calls) {
  const detail = failedPushDetail(calls);
  if (typeof detail !== "string" || detail.trim() === "") return ["failure-reason:missing-or-nonstring"];
  if (detail.length > FAILURE_DETAIL_MAX_LENGTH) return ["failure-reason:unbounded"];
  if (detail.includes("\n")) return ["failure-reason:multi-line"];
  // response-normalization fails INSIDE the normalization probe (the thrown
  // normalization error), every other injected stage throws the boundary error.
  const expectedCause = stage === "response-normalization"
    ? "wo009 normalization probe issues"
    : "wo009 injected boundary failure";
  if (!detail.includes(expectedCause)) return ["failure-reason:cause-lost"];
  return [];
}

/**
 * The end-to-end reporting path for the card's primary scenario: a failing
 * inference request must be readable off the extension's own diagnostic
 * surface (stage + preserved reason + timestamp), so a host-only failure is
 * copyable evidence without a code change.
 */
async function assertFailureReportedOnDiagnoseSurface() {
  const host = await activateHost(failureOptions("inference-request"));
  await invoke(host, "wo009-failure-report");
  assertStageTrace(host, "inference-request");

  await withDeadline(host.runtime.run(DIAGNOSE_COMMAND), "post-failure diagnostics render");
  const report = host.calls.updateAttempts.findLast((request) => request.id === FAILURE_REPORT_ID && request.content);
  assert.ok(report, "the diagnostics command must render its report after a failure");
  const block = report.content.find((entry) => entry?.type === "kv" && entry.title === "Last failure");
  assert.ok(block, "the diagnostics report must carry the Last failure section");
  const rows = Object.fromEntries(block.items.map((item) => [item.label, item.value]));
  assert.equal(rows.stage, "inference-request", "the report must name the failed stage");
  assert.match(rows.reason, /wo009 injected boundary failure/, "the report must carry the preserved reason");
  assert.match(rows.at, /^\d{4}-\d{2}-\d{2}T/, "the report must timestamp the recorded failure");
  assert.equal(rows.reason.length <= FAILURE_DETAIL_MAX_LENGTH, true, "the reported reason must stay bounded");

  // t_5bffad26: the report also carries the Theme section, so a native run
  // answers what the host hands a view frame instead of guessing. This host has
  // no theme API at all — the section must still be readable and never throw.
  const themeBlock = report.content.find((entry) => entry?.type === "kv" && entry.title === "Theme");
  assert.ok(themeBlock, "the diagnostics report must carry the Theme section");
  const themeRows = Object.fromEntries(themeBlock.items.map((item) => [item.label, item.value]));
  assert.match(themeRows["pane frame report"], /diagnostic-stage=diagnose-theme/);
  assert.match(themeRows["runtime theme API"], /diagnostic-stage=diagnose-theme/);
  assert.equal(themeRows["runtime colorScheme"], "(unreported)");
  for (const item of themeBlock.items) {
    assert.equal(
      typeof item.value === "string" && item.value.trim() !== "",
      true,
      `theme row "${item.label}" must render a readable value`
    );
  }

  // With the pane's published report present, the section renders the frame's
  // own observation: the values a view frame actually sees.
  await host.msty.storage.chat.set(THEME_REPORT_STORAGE_KEY, {
    scheme: "light",
    hostScheme: "light",
    themeChangedFired: false,
    computed: { "--foreground": "rgb(22, 24, 29)" },
    tokens: { "--background": "#ffffff" },
    at: "2026-09-22T20:05:00.000Z"
  });
  await withDeadline(host.runtime.run(DIAGNOSE_COMMAND), "diagnostics render with a frame report");
  const storedReport = host.calls.updateAttempts.findLast((request) => request.id === FAILURE_REPORT_ID && request.content);
  const storedBlock = storedReport.content.find((entry) => entry?.type === "kv" && entry.title === "Theme");
  const storedRows = Object.fromEntries(storedBlock.items.map((item) => [item.label, item.value]));
  assert.equal(storedRows["pane data-rv-scheme"], "light");
  assert.equal(storedRows["computed --foreground"], "rgb(22, 24, 29)");
  assert.equal(storedRows["computed --card"], "(absent)");
  assert.equal(storedRows["theme.getTokens() --background"], "#ffffff");
}

// Probe-only export for tests/scratch traces (harness internals).
export { activateHost, invoke, traceCounts, failureOptions, emittedFailureOutputs };

function emittedFailureOutputs(calls) {
  return {
    calloutTexts: calloutBlocks(calls.emittedUpdates.concat(calls.opened)).map((block) => block.body),
    notificationMessages: calls.notifications
      .filter((notification) => notification.tone === "error")
      .map((notification) => notification.body)
  };
}

function attemptedFailureCallouts(calls) {
  return calloutBlocks(calls.updateAttempts.concat(calls.opened));
}

function telemetryViolations(stage, outputs, { requireCallout = true } = {}) {
  const violations = [];
  const inspect = (channel, values) => {
    if (!values.length) {
      violations.push(`${channel}:missing`);
      return;
    }
    for (const [index, value] of values.entries()) {
      if (typeof value !== "string" || value.trim() === "") {
        violations.push(`${channel}[${index}]:empty-or-nonstring`);
        continue;
      }
      const markers = stageMarkers(value);
      const markerSet = new Set(markers);
      if (markers.length === 0) violations.push(`${channel}[${index}]:missing-stage`);
      else if (markerSet.size !== 1 || !markerSet.has(stage)) {
        violations.push(`${channel}[${index}]:wrong-stage-${[...markerSet].sort().join(",")}`);
      }
      if ([...markerSet].some((identifier) => !STAGE_SET.has(identifier))) {
        violations.push(`${channel}[${index}]:unknown-stage`);
      }
    }
  };

  if (requireCallout || outputs.calloutTexts.length) inspect("callout", outputs.calloutTexts);
  inspect("notification", outputs.notificationMessages);
  return violations;
}

function safeOutputSummary(outputs) {
  const summarize = (values) => values.map((value) => ({
    type: value === null ? "null" : typeof value,
    length: typeof value === "string" ? value.length : null,
    markers: stageMarkers(value)
  }));
  return `callout=${JSON.stringify(summarize(outputs.calloutTexts))};notification=${JSON.stringify(summarize(outputs.notificationMessages))}`;
}

function assertNoChatOrComposerSideEffects(host) {
  assert.equal("create" in host.msty.messages, false, "diagnostic host must not expose chat insertion");
  assert.equal("append" in host.msty.messages, false, "diagnostic host must not expose chat append");
  assert.equal("startRun" in (host.msty.chats ?? {}), false, "diagnostic host must not expose a second assistant run path");
  assert.equal(host.calls.composerSet.length, 0, "failure must not submit a composer revision prompt");
}

async function runDT1() {
  const host = await activateHost();
  await invoke(host, "wo009-baseline");
  assert.equal(host.calls.opened.length, 1, "DT1 must observe the pane auto-open");
  assert.equal("kind" in host.calls.opened[0], false, "DT1 pane opens by its declared contribution id, without kind");
  assert.equal(host.calls.opened[0].id, "hermes-review-pane", "DT1 pane opens the declared popup contribution");
  assert.equal(host.calls.inferAttempts.length, 1, "DT1 must execute one isolated inference");
  assert.equal(host.calls.storageSets.length, 1, "DT1 must persist the completed review to chat history");
  assert.equal(host.calls.chromeUpdates.some((request) => request.badge === "1"), true, "DT1 launcher badge shows one stored review after the run");
  assert.equal(host.calls.notifications.at(-1)?.tone, "success", "DT1 must observe the success notification");
  assertNoChatOrComposerSideEffects(host);

  const fallback = await activateHost({
    reviewerStatus: { ready: false, configured: false, source: "unavailable", modelAssignment: "reviewer" }
  });
  await invoke(fallback, "wo009-unready-reviewer");
  assert.equal("modelAssignment" in fallback.calls.infer[0], false, "unready reviewer must omit modelAssignment");
  assert.equal(fallback.calls.chromeUpdates.some((request) => request.badge === "1"), true, "unready reviewer still persists and badges");

  const configuredFallback = await activateHost({
    reviewerStatus: { ready: true, configured: true, source: "fallback", modelAssignment: "reviewer" }
  });
  await invoke(configuredFallback, "wo009-configured-fallback-reviewer");
  assert.equal("modelAssignment" in configuredFallback.calls.infer[0], false, "ready+configured fallback must omit modelAssignment");

  const readyButUnconfigured = await activateHost({
    reviewerStatus: { ready: true, configured: false, source: "fallback", modelAssignment: "reviewer" }
  });
  await invoke(readyButUnconfigured, "wo009-ready-unconfigured-reviewer");
  assert.equal("modelAssignment" in readyButUnconfigured.calls.infer[0], false, "ready+unconfigured reviewer must omit modelAssignment");

  const undefinedSource = await activateHost({
    reviewerStatus: { ready: true, configured: true, source: undefined, modelAssignment: "reviewer" }
  });
  await invoke(undefinedSource, "wo009-undefined-source");
  assert.equal("modelAssignment" in undefinedSource.calls.infer[0], false, "undefined source must omit modelAssignment");

  const unknownSource = await activateHost({
    reviewerStatus: { ready: true, configured: true, source: "unknown", modelAssignment: "reviewer" }
  });
  await invoke(unknownSource, "wo009-unknown-source");
  assert.equal("modelAssignment" in unknownSource.calls.infer[0], false, "unknown source must omit modelAssignment");

  const textOnly = await activateHost({ inferTextOnly: true });
  await invoke(textOnly, "wo009-text-only-result");
  assert.equal(textOnly.calls.storageSets.length, 1, "text-only result must persist successfully");
  assert.equal(textOnly.calls.notifications.at(-1)?.tone, "success", "text-only result must complete successfully");
}

async function runDT2() {
  const failures = [];
  for (const stage of STAGE_IDS) {
    const host = await activateHost(failureOptions(stage));
    await invoke(host);
    assertStageTrace(host, stage);
    const outputs = emittedFailureOutputs(host.calls);
    // Card D: on the history-persistence stage the review itself still
    // completes; the only stage-token channel is the "Review history not
    // saved" warning toast. Every other failure stage reports through the
    // error toast plus the `failed` lifecycle context push (rework
    // t_464e32ac re-pinned the callout channel — it is required again).
    const violations = stage === "history-persistence"
      ? (() => {
        const warnings = host.calls.notifications
          .filter((notification) => notification.title === "Review history not saved")
          .map((notification) => notification.body);
        return warnings.length === 1 && stageMarkers(warnings[0]).join() === stage ? [] : ["history-warning:missing-or-wrong-stage"];
      })()
      : telemetryViolations(stage, outputs, { requireCallout: true });
    if (violations.length) failures.push(`${stage}(${violations.join(",")};${safeOutputSummary(outputs)})`);
    // t_fa7ab623: every failing stage must also carry a bounded reason. The
    // history-persistence stage is the documented exception — the review still
    // completes there (its only channel is the bare-token warning toast).
    if (stage !== "history-persistence") {
      const reasonViolations = failureReasonViolations(stage, host.calls);
      if (reasonViolations.length) failures.push(`${stage}(${reasonViolations.join(",")})`);
    }
  }
  if (failures.length) {
    throw new DesignedRedError(`DT2 stage-localization mismatches: ${failures.join(" | ")}`);
  }
  // One concrete end-to-end example of what a failing inference request now
  // reports (t_fa7ab623): the reason is readable off the diagnostic surface.
  await assertFailureReportedOnDiagnoseSurface();
}

function opaqueCases() {
  return [
    { name: "empty-error", valueFactory: () => new Error("") },
    { name: "undefined", valueFactory: () => undefined },
    { name: "null", valueFactory: () => null },
    { name: "empty-object", valueFactory: () => ({}) },
    {
      name: "serialization-failure",
      valueFactory: () => {
        const value = {};
        value.self = value;
        return value;
      }
    }
  ];
}

async function executeOpaqueCase(testCase) {
  const host = await activateHost(failureOptions("inference-request", { failureValueFactory: testCase.valueFactory }));
  await invoke(host);
  assertStageTrace(host, "inference-request");
  return { host, outputs: emittedFailureOutputs(host.calls) };
}

async function runDT3() {
  const failures = [];
  for (const testCase of opaqueCases()) {
    const first = await executeOpaqueCase(testCase);
    const second = await executeOpaqueCase(testCase);
    assert.deepEqual(
      first.outputs.calloutTexts.map(outputSignature),
      second.outputs.calloutTexts.map(outputSignature),
      `DT3 ${testCase.name} callout output must be deterministic`
    );
    assert.deepEqual(
      first.outputs.notificationMessages.map(outputSignature),
      second.outputs.notificationMessages.map(outputSignature),
      `DT3 ${testCase.name} notification output must be deterministic`
    );
    const violations = telemetryViolations("inference-request", first.outputs, { requireCallout: true });
    if (violations.length) failures.push(`${testCase.name}(${violations.join(",")};${safeOutputSummary(first.outputs)})`);
  }
  if (failures.length) {
    throw new DesignedRedError(`DT3 opaque-error diagnostic mismatches: ${failures.join(" | ")}`);
  }
}

const SECRET_TRANSCRIPT = "wo009-secret-transcript-content";
const SECRET_USER_PAYLOAD = "wo009-secret-user-payload";
const SECRET_PROVIDER = "wo009-secret-provider-id";
const SECRET_MODEL = "wo009-secret-model-id";
const SECRET_ERROR = "wo009-secret-error-message";
const SECRET_PROPERTY = "wo009-secret-property-name";
const SECRET_NESTED = "wo009-secret-nested-value";
const SECRET_ARRAY = "wo009-secret-array-value";
const SECRET_STACK = "wo009-secret-stack-value";
const SECRET_SERIALIZATION = "wo009-secret-serialization-path";
// Credential-shaped fixtures (t_fa7ab623): what a real provider error quotes.
const SECRET_API_KEY = "sk-live-9f8e7d6c5b4a3210";
const SECRET_BEARER = "Bearer ya29.a0AfH6SMDoqQbUwE1n";
const SECRET_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3bzAwOS1qd3QifQ.QwErTyUiOp123456";

function disclosureCases() {
  return [
    {
      name: "error-message-and-stack",
      valueFactory: () => {
        const error = new Error(SECRET_ERROR);
        error.stack = SECRET_STACK;
        return error;
      },
      forbidden: [SECRET_ERROR, SECRET_STACK, "stack", "message"],
      // The reason channel is EXPECTED to carry this error's own message (that
      // is the card's deliverable); it must never carry the stack.
      detailForbidden: [SECRET_STACK]
    },
    {
      name: "nested-object-properties",
      valueFactory: () => ({
        [SECRET_PROPERTY]: SECRET_NESTED,
        nested: { [SECRET_PROPERTY]: SECRET_NESTED },
        stack: SECRET_STACK
      }),
      forbidden: [SECRET_PROPERTY, SECRET_NESTED, SECRET_STACK, "nested", "stack"],
      detailForbidden: [SECRET_PROPERTY, SECRET_NESTED, SECRET_STACK]
    },
    {
      name: "array-values",
      valueFactory: () => [SECRET_ARRAY, { [SECRET_PROPERTY]: SECRET_NESTED }],
      forbidden: [SECRET_ARRAY, SECRET_PROPERTY, SECRET_NESTED],
      detailForbidden: [SECRET_ARRAY, SECRET_PROPERTY, SECRET_NESTED]
    },
    {
      name: "thrown-serialization-path",
      valueFactory: () => ({
        [SECRET_PROPERTY]: SECRET_SERIALIZATION,
        toJSON() {
          throw new Error(SECRET_SERIALIZATION);
        }
      }),
      forbidden: [SECRET_PROPERTY, SECRET_SERIALIZATION, "toJSON"],
      detailForbidden: [SECRET_PROPERTY, SECRET_SERIALIZATION]
    },
    {
      // t_fa7ab623: a provider error that echoes the run's own content back.
      // The detail must redact the transcript and the user's instruction before
      // it can be rendered or copied. Provider/model identifiers are
      // deliberately NOT asserted here: the extension never learns them (it
      // sends the reviewer assignment, not a model id), so it cannot redact a
      // value it was never given — the host's own error text is the only place
      // they could appear, and that is the reason this card wanted surfaced.
      name: "run-content-echo",
      valueFactory: () => new Error(`request rejected for: ${SECRET_TRANSCRIPT} :: ${SECRET_USER_PAYLOAD}`),
      forbidden: [SECRET_ERROR],
      detailForbidden: [SECRET_TRANSCRIPT, SECRET_USER_PAYLOAD]
    },
    {
      // t_fa7ab623: credential-shaped secrets inside a provider error must be
      // redacted by shape, since the extension never learns the real values.
      name: "credential-echo",
      valueFactory: () => new Error(`401 unauthorized: ${SECRET_BEARER} and ${SECRET_API_KEY} and ${SECRET_JWT}`),
      forbidden: [SECRET_ERROR],
      detailForbidden: [SECRET_BEARER, SECRET_API_KEY, SECRET_JWT]
    }
  ];
}

/**
 * Tokens that may NEVER appear in the reason channel: everything the run itself
 * handled. The error's own message is permitted there by design (that is what
 * this card surfaces); the run's content is not.
 */
const ALWAYS_FORBIDDEN_IN_DETAIL = [SECRET_TRANSCRIPT, SECRET_USER_PAYLOAD];

/**
 * Defines an own `key` getter on `target` that throws when read. Real failures
 * arrive as bridge/provider proxies whose own properties can throw (B0, review
 * round 1).
 * @param {any} target @param {string} key
 */
function withThrowingGetter(target, key) {
  Object.defineProperty(target, key, {
    configurable: true,
    get() {
      throw new Error(`wo009 hostile ${key} getter`);
    }
  });
  return target;
}

/**
 * B0 (review round 1): a real Error carrying an own throwing `name`/`message`
 * getter used to make `describeFailure` throw — which escaped
 * `runDiagnosticStage` (raw value instead of a ReviewStageError), then
 * `executeReview`'s catch, then the runner's catch, so the failure produced no
 * pane push, no toast and no diagnostic record at all: the exact defect this
 * card exists to remove, one edge deeper. These fixtures assert the failure
 * stays visible AND classified.
 */
function hostileGetterCases() {
  return [
    { name: "throwing-name-getter", valueFactory: () => withThrowingGetter(new Error("wo009 hostile name cause"), "name") },
    { name: "throwing-message-getter", valueFactory: () => withThrowingGetter(new Error("wo009 hostile message cause"), "message") },
    {
      name: "throwing-name-and-message-getters",
      valueFactory: () => withThrowingGetter(withThrowingGetter(new Error("wo009 hostile both cause"), "name"), "message")
    }
  ];
}

/**
 * Values that defeat classification outright must still not raise: the
 * never-throw contract of `describeFailure` and of the `runDiagnosticStage`
 * wrapper that depends on it.
 */
function unclassifiableCases() {
  return [
    ...hostileGetterCases(),
    {
      name: "throwing-prototype-trap",
      valueFactory: () => new Proxy({}, {
        getPrototypeOf() {
          throw new Error("wo009 hostile prototype trap");
        },
        get() {
          throw new Error("wo009 hostile get trap");
        }
      })
    },
    {
      name: "throwing-to-primitive",
      valueFactory: () => ({
        [Symbol.toPrimitive]() {
          throw new Error("wo009 hostile toPrimitive");
        }
      })
    }
  ];
}

/**
 * Direct never-throw assertions for the classifier every failure path depends
 * on (B0). Returns violation tokens instead of throwing, so DT4 keeps its own
 * designed-red bookkeeping.
 * @param {{name: string, valueFactory: () => unknown}} testCase
 */
async function classifierViolations(testCase) {
  const violations = [];
  const thrown = testCase.valueFactory();
  let detail;
  try {
    detail = describeFailure(thrown);
  } catch {
    violations.push("describe-failure-threw");
  }
  if (typeof detail !== "string" || detail.trim() === "") violations.push("describe-failure-blank");
  else if (detail.length > FAILURE_DETAIL_MAX_LENGTH) violations.push("describe-failure-unbounded");
  try {
    await runDiagnosticStage("inference-request", () => {
      throw thrown;
    });
    violations.push("stage-wrapper-did-not-fail");
  } catch (error) {
    if (!(error instanceof ReviewStageError)) violations.push("stage-wrapper-contract-broken");
    else {
      if (typeof error.detail !== "string" || error.detail.trim() === "") violations.push("stage-wrapper-detail-missing");
      if (error.cause !== thrown) violations.push("stage-wrapper-cause-lost");
    }
  }
  return violations;
}

async function runDT4() {
  const failures = [];
  for (const testCase of disclosureCases()) {
    const host = await activateHost(failureOptions("inference-request", {
      messages: [{ id: "wo009-secret-message", role: "user", content: SECRET_TRANSCRIPT }],
      failureValueFactory: testCase.valueFactory
    }));
    await invoke(host, SECRET_USER_PAYLOAD);
    assertStageTrace(host, "inference-request");
    assert.equal(host.calls.infer.length, 1, `DT4 ${testCase.name} must reach the isolated inference request`);
    assert.equal("providerId" in host.calls.infer[0], false, `DT4 ${testCase.name} must not send provider IDs`);
    assert.equal("modelId" in host.calls.infer[0], false, `DT4 ${testCase.name} must not send model IDs`);
    const userPrompt = host.calls.infer[0].messages.find((message) => message.role === "user")?.content ?? "";
    assert.match(userPrompt, new RegExp(SECRET_TRANSCRIPT), `DT4 ${testCase.name} transcript fixture must be exercised`);
    assert.match(userPrompt, new RegExp(SECRET_USER_PAYLOAD), `DT4 ${testCase.name} user-payload fixture must be exercised`);

    const outputs = emittedFailureOutputs(host.calls);
    // Card D: the drawer callout is gone; the disclosure surfaces are the
    // error toast and the `failed` lifecycle context push (both required).
    const violations = telemetryViolations("inference-request", outputs, { requireCallout: true });
    for (const [channel, values] of Object.entries({ callout: outputs.calloutTexts, notification: outputs.notificationMessages })) {
      for (const [index, value] of values.entries()) {
        if (typeof value !== "string") continue;
        for (const forbidden of testCase.forbidden.concat([SECRET_TRANSCRIPT, SECRET_USER_PAYLOAD, SECRET_PROVIDER, SECRET_MODEL])) {
          if (value.includes(forbidden)) violations.push(`${channel}[${index}]:disclosed-forbidden-token`);
        }
      }
    }

    // t_fa7ab623: the preserved reason is a NEW user-visible channel (the pane's
    // details line and the diagnostics report), so it is asserted here with the
    // same rigour: bounded, and free of run content and credentials. The error's
    // OWN message is permitted — that is the point of the card — but nothing the
    // run handled may be echoed back with it.
    const detail = failedPushDetail(host.calls);
    if (typeof detail !== "string" || detail.trim() === "") violations.push("failure-detail:missing-or-nonstring");
    if (typeof detail === "string") {
      if (detail.length > FAILURE_DETAIL_MAX_LENGTH) violations.push("failure-detail:unbounded");
      if (detail.includes("\n")) violations.push("failure-detail:multi-line");
      for (const forbidden of (testCase.detailForbidden ?? []).concat(ALWAYS_FORBIDDEN_IN_DETAIL)) {
        if (detail.includes(forbidden)) violations.push(`failure-detail:disclosed-${forbidden}`);
      }
    }

    // Designed-red evidence: the redaction is what keeps the reason channel
    // clean. `run-content-echo` and `credential-echo` fail this gate the moment
    // review-core's boundFailureDetail stops redacting (verified by disabling
    // the redaction pass during development) — the disclosure checks above fire
    // first in that case, and the marker assertions below only hold when the
    // channel is genuinely clean.
    if (!violations.length && (testCase.name === "run-content-echo" || testCase.name === "credential-echo")) {
      assert.equal(typeof detail, "string", `DT4 ${testCase.name} must still report a reason`);
      assert.match(detail, /\[redacted\]/, `DT4 ${testCase.name} must show the redaction marker where the secret was`);
      assert.match(detail, /^Error: /, `DT4 ${testCase.name} must keep the plain reason shape`);
    }

    if (violations.length) failures.push(`${testCase.name}(${violations.join(",")};${safeOutputSummary(outputs)})`);
  }

  // B0 (review round 1): end-to-end — a hostile-getter failure must still
  // produce the `failed` push (with a bounded reason), the stage-token toast and
  // the diagnostic record. Before the classifier was made never-throw this path
  // produced nothing at all: no push, no toast, no record.
  for (const testCase of hostileGetterCases()) {
    const host = await activateHost(failureOptions("inference-request", { failureValueFactory: testCase.valueFactory }));
    await invoke(host, "wo009-hostile-getter");
    assertStageTrace(host, "inference-request");
    const outputs = emittedFailureOutputs(host.calls);
    const detail = failedPushDetail(host.calls);
    const violations = telemetryViolations("inference-request", outputs, { requireCallout: true });
    if (typeof detail !== "string" || detail.trim() === "") violations.push("failure-detail:missing-or-nonstring");
    else {
      if (detail.length > FAILURE_DETAIL_MAX_LENGTH) violations.push("failure-detail:unbounded");
      if (detail.includes("\n")) violations.push("failure-detail:multi-line");
      // The name read failed, so the classification degrades to the plain
      // fallback name — never to nothing.
      if (!detail.startsWith("Error")) violations.push("failure-detail:unclassified");
      for (const forbidden of ALWAYS_FORBIDDEN_IN_DETAIL) {
        if (detail.includes(forbidden)) violations.push(`failure-detail:disclosed-${forbidden}`);
      }
    }
    if (violations.length) failures.push(`${testCase.name}(${violations.join(",")};${safeOutputSummary(outputs)})`);
  }

  // B0 (review round 1): the never-throw contract of the classifier itself.
  for (const testCase of unclassifiableCases()) {
    const violations = await classifierViolations(testCase);
    if (violations.length) failures.push(`${testCase.name}(${violations.join(",")})`);
  }

  if (failures.length) {
    throw new DesignedRedError(`DT4 secret-disclosure diagnostic mismatches: ${failures.join(" | ")}`);
  }
}

async function runDT5() {
  const designedRedFailures = [];
  for (const stage of STAGE_IDS) {
    const host = await activateHost(failureOptions(stage));
    await invoke(host);
    assertStageTrace(host, stage);
    assertNoChatOrComposerSideEffects(host);

    const cacheFailure = stage === "history-persistence";
    const firstSuccessCount = host.calls.notifications.filter((item) => item.tone === "success").length;
    const firstErrorCount = host.calls.notifications.filter((item) => item.tone === "error").length;
    if (cacheFailure) {
      if (firstSuccessCount !== 1) designedRedFailures.push(`${stage}:cache-failure-did-not-preserve-success`);
      // Card D: the "Review cache unavailable" warning is retired with the
      // legacy-drawer cache; a still-failing history write instead reports
      // "Review history not saved" with the bare stage token.
      const warning = host.calls.notifications.find((item) => item.title === "Review history not saved");
      if (!warning || warning.tone !== "warning" || !/diagnostic-stage=[a-z0-9-]+$/.test(warning.body ?? "")) {
        designedRedFailures.push(`${stage}:missing-safe-cache-warning`);
      }
    } else {
      if (firstSuccessCount !== 0) designedRedFailures.push(`${stage}:failed-invocation-reported-success`);
      if (firstErrorCount !== 1) designedRedFailures.push(`${stage}:error-notification-count-${firstErrorCount}`);
    }
    // Card D: failure visibility moves into the pane. The runner's failure
    // channel is the error toast carrying the bare stage token (asserted via
    // telemetryViolations in DT2) — there is no drawer callout attempt anymore.
    const failureToast = host.calls.notifications.find((item) => item.tone === "error");
    if (!cacheFailure && (!failureToast || !/diagnostic-stage=/.test(failureToast.body ?? ""))) {
      designedRedFailures.push(`${stage}:missing-stage-token-failure-toast`);
    }

    const before = {
      starts: host.calls.events.filter((event) => event === "notification:default:Review started").length,
      success: firstSuccessCount,
      storage: host.calls.storageSets.length,
      lifecyclePatches: host.calls.updateAttempts.filter((item) => item?.context?.review).length,
      infer: host.calls.inferAttempts.length
    };
    await invoke(host, "wo009-after-failure");
    const afterSuccess = host.calls.notifications.filter((item) => item.tone === "success").length;
    if (afterSuccess - before.success !== 1) designedRedFailures.push(`${stage}:later-normal-invocation-did-not-complete`);
    if (host.calls.storageSets.length - before.storage !== 1) designedRedFailures.push(`${stage}:later-normal-invocation-storage-delta`);
    // Rework t_464e32ac: the surface liveness signal is the still-pending open
    // promise (real-host semantics — this suite's openContribution keeps it
    // pending until a close), so a second invocation opens no second surface
    // and re-surfaces its running phase via updateSurface (at least one more
    // lifecycle patch). A toggle/dismiss closes the pane and the next /review
    // opens a fresh one (pane-suite PD9).
    if (host.calls.updateAttempts.filter((item) => item?.context?.review).length - before.lifecyclePatches < 1) {
      designedRedFailures.push(`${stage}:later-normal-invocation-lifecycle-patch-delta`);
    }
    if (host.calls.events.filter((event) => event === "notification:default:Review started").length - before.starts !== 1) {
      designedRedFailures.push(`${stage}:duplicate-or-missing-later-workflow-start`);
    }
    if (host.calls.inferAttempts.length - before.infer !== 1) designedRedFailures.push(`${stage}:later-normal-invocation-inference-delta`);
    assertNoChatOrComposerSideEffects(host);
  }
  if (designedRedFailures.length) {
    throw new DesignedRedError(`DT5 side-effect boundary mismatches: ${designedRedFailures.join(" | ")}`);
  }
}

function assertExpectedRedClassification(results) {
  const expected = {
    DT1: "PASS",
    DT2: "PASS",
    DT3: "PASS",
    DT4: "PASS",
    DT5: "PASS"
  };
  for (const [gate, status] of Object.entries(expected)) {
    assert.equal(results.find((result) => result.gate === gate)?.status, status, `DT6 ${gate} must report ${status}`);
  }
  assert.equal(results.some((result) => result.status === "UNEXPECTED_FAILURE"), false, "DT6 must report zero unexpected failures");
  assert.equal(results.filter((result) => result.status === "DESIGNED_RED").length, 0, "DT6 corrected run must have no designed-red telemetry gates");
}

function runProcess(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.error, undefined, `${label} process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `${label} exited ${result.status}`);
  return result;
}

async function runDT7() {
  runProcess(process.execPath, ["--check", DIAGNOSTIC_HARNESS_PATH], "diagnostic harness syntax check");
  runProcess(process.execPath, ["--check", ENTRY_PATH], "extension syntax check");
  const lifecycle = runProcess(process.execPath, [LIFECYCLE_HARNESS_PATH], "approved lifecycle contract");
  assert.match(lifecycle.stdout, /Corrective lifecycle contract: 9 passed, 0 non-passing gate\(s\)\./);
  const existing = runProcess(process.execPath, [EXISTING_HARNESS_PATH], "approved existing contract");
  assert.match(existing.stdout, /Hermes Review contract checks passed \(7 scenarios\)\./);
}

const gateDefinitions = [
  { id: "DT1", title: "Baseline success and harness integrity", expected: "PASS", run: runDT1 },
  { id: "DT2", title: "Stage localization and preserved failure reason", expected: "PASS", run: runDT2 },
  { id: "DT3", title: "Non-empty opaque-error fallback", expected: "PASS", run: runDT3 },
  { id: "DT4", title: "Secret non-disclosure and hostile-value failure safety", expected: "PASS", run: runDT4 },
  { id: "DT5", title: "Existing UX and side-effect boundaries", expected: "PASS", run: runDT5 }
];

const results = [];
for (const gate of gateDefinitions) {
  try {
    await gate.run();
    results.push({ gate: gate.id, title: gate.title, status: "PASS", expectedBaseline: gate.expected });
    console.log(`[PASS][${gate.id}] ${gate.title}`);
  } catch (error) {
    const observed = error instanceof DesignedRedError ? "DESIGNED_RED" : "UNEXPECTED_FAILURE";
    const status = observed === gate.expected ? observed : "UNEXPECTED_FAILURE";
    const message = error?.message ?? String(error);
    const reportedMessage = status === observed ? message : `${message} (observed ${observed}; expected ${gate.expected})`;
    results.push({ gate: gate.id, title: gate.title, status, expectedBaseline: gate.expected, error: reportedMessage });
    console.error(`[${status}][${gate.id}] ${gate.title}: ${reportedMessage}`);
  }
}

try {
  assertExpectedRedClassification(results);
  results.push({ gate: "DT6", title: "Honest expected-red classification", status: "PASS", expectedBaseline: "PASS" });
  console.log("[PASS][DT6] Honest expected-red classification");
} catch (error) {
  results.push({ gate: "DT6", title: "Honest expected-red classification", status: "UNEXPECTED_FAILURE", expectedBaseline: "PASS", error: error?.message ?? String(error) });
  console.error(`[UNEXPECTED_FAILURE][DT6] Honest expected-red classification: ${error?.message ?? String(error)}`);
}

try {
  await runDT7();
  results.push({ gate: "DT7", title: "Regression preservation", status: "PASS", expectedBaseline: "PASS" });
  console.log("[PASS][DT7] Regression preservation");
} catch (error) {
  results.push({ gate: "DT7", title: "Regression preservation", status: "UNEXPECTED_FAILURE", expectedBaseline: "PASS", error: error?.message ?? String(error) });
  console.error(`[UNEXPECTED_FAILURE][DT7] Regression preservation: ${error?.message ?? String(error)}`);
}

const unexpected = results.filter((result) => result.status === "UNEXPECTED_FAILURE");
const designedRed = results.filter((result) => result.status === "DESIGNED_RED");
const passed = results.filter((result) => result.status === "PASS");
console.log(`WO009_RESULT_MATRIX=${JSON.stringify(results)}`);
console.log(`WO009_SUMMARY=passed:${passed.length};designed_red:${designedRed.length};unexpected_failure:${unexpected.length};total:${results.length}`);
if (unexpected.length || designedRed.length > 0) process.exitCode = 1;
