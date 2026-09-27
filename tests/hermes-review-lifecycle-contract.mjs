import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAILURE_DETAIL_MAX_LENGTH } from "../hermes-review-extension/review-core.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..");
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "hermes-review-extension");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.json");
const EXISTING_HARNESS_PATH = path.join(TEST_DIR, "hermes-review-contract.mjs");
// Card D updated the base harness stubs (drawer -> popup contribution), so the
// accepted snapshot below is the card-D revision, re-verified green. Rework
// t_464e32ac extended the stub's ui.openContribution whitelist with the
// documented `headerActions` field (d.ts UiOpenContributionRequest), so the
// accepted snapshot below is the rework revision, re-verified green (7/7).
// t_61dd1e7e round 2 extended the same whitelist with the documented
// `contextSync` field (d.ts UiOpenContributionRequest) — snapshot re-pinned,
// re-verified green (7/7).
// t_9622dfc8 item B: the base harness's openContribution stub now asserts the
// pane is opened by its DECLARED contribution id WITHOUT `kind` (guide:1098-1122)
// — snapshot re-pinned, re-verified green (7/7).
const EXISTING_HARNESS_SHA256 = "8da79d34db7d1844f388483e3b6197b158405073109433c92ea056a244745cab";
const DEADLINE_MS = 1_000;

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const entryPath = path.resolve(PACKAGE_ROOT, manifest.entry);
const moduleNamespace = await import(`${pathToFileURL(entryPath).href}?wo003=${Date.now()}`);
const commandContributions = manifest.contributes?.commands ?? [];
const contribution = commandContributions[0];
const runtimeCommand = contribution?.command;
const slashCommand = typeof contribution?.slashName === "string" ? `/${contribution.slashName.replace(/^\//, "")}` : null;
const commandsProvidePermission = manifest.permissions?.find((permission) => permission?.id === "commands.provide");

const STRUCTURED_REVIEW = {
  summary: "No material issues found.",
  issues: []
};

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
  // Re-pinned (rework t_464e32ac, extended t_61dd1e7e round 2, amended
  // t_9622dfc8): the OPEN request is made by the DECLARED contribution id and
  // carries NO `kind` — the guide prefers opening a declared
  // dialog/drawer/popup/fullView by its contribution ID, and `kind` is optional
  // when that ID is unique across the declared overlays (guide:1098-1122). The
  // PATCH (`updateSurface`) still names the surface by id + kind, the shape it
  // documents. Both carry the host header action, the documented contextSync
  // option (d.ts UiOpenContributionRequest) and the runner's lifecycle context.
  const allowed = ["id", "context", "headerActions", "contextSync"];
  if (patch) allowed.push("kind");
  assertExactKeys(request, allowed, label);
  if (patch) {
    assert.equal(request.kind, "popup", `${label} kind`);
  } else {
    assert.equal("kind" in request, false, `${label} opens the declared contribution by id, without kind`);
  }
  assert.equal(request.id, "hermes-review-pane", `${label} id targets the pane contribution`);
  if (request.headerActions !== undefined && request.headerActions !== null) {
    assert.equal(Array.isArray(request.headerActions), true, `${label} headerActions`);
    for (const action of request.headerActions) {
      assertExactKeys(action, ["id", "label", "icon", "variant", "disabled"], `${label} headerAction`);
      assert.equal(action.id, "clear", `${label} headerAction id`);
      assert.equal(action.icon, "trash", `${label} headerAction icon`);
      assert.equal(action.variant, "danger", `${label} headerAction variant`);
      assert.equal(typeof action.disabled, "boolean", `${label} headerAction disabled`);
    }
  }
  if (request.context !== undefined && request.context !== null) {
    const review = request.context?.review;
    assert.equal(review && typeof review === "object" && !Array.isArray(review), true, `${label} context.review must be an object`);
    assert.equal(["idle", "running", "complete", "failed"].includes(review.phase), true, `${label} context.review.phase`);
    // t_fa7ab623 adds the bounded reason that rides beside the failure stage
    // token. The token stays the designed surface; `failureDetail` is the
    // preserved cause (bounded + redacted in review-core) and is only ever
    // present on a `failed` push.
    const allowedReview = ["phase", "chatId", "instruction", "completionBody", "failureStage", "failureDetail"];
    const unexpected = Object.keys(review).filter((key) => !allowedReview.includes(key));
    assert.deepEqual(unexpected, [], `${label} context.review undocumented fields: ${unexpected.join(", ")}`);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class GateBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateBlockedError";
  }
}

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

async function resolvePackageEntry(packageRoot) {
  const rootManifestPath = path.join(packageRoot, "manifest.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(rootManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Package root must contain a readable manifest.json: ${rootManifestPath}`, { cause: error });
  }
  assert.equal(typeof parsed.entry, "string", "T1 manifest entry must be a string");
  assert.notEqual(parsed.entry.trim(), "", "T1 manifest entry must not be empty");
  const resolved = path.resolve(packageRoot, parsed.entry);
  try {
    await access(resolved, fsConstants.R_OK);
  } catch (error) {
    throw new Error(`Manifest entry does not resolve at package root: ${parsed.entry}`, { cause: error });
  }
  return { manifest: parsed, manifestPath: rootManifestPath, entryPath: resolved };
}

function createHost(options = {}) {
  const events = [];
  const calls = {
    events,
    notifications: [],
    lists: [],
    infer: [],
    modelStatuses: [],
    opened: [],
    updates: [],
    chromeUpdates: [],
    composerSet: [],
    composerGets: 0,
    composerClear: 0,
    storageSets: [],
    workspaceItems: [],
    commandRegistrations: []
  };
  const stored = new Map();

  const msty = {
    context: {
      async getCurrentChat() {
        events.push("context.current");
        return options.currentChat ?? { chat: { id: "wo003-chat" }, messages: [] };
      }
    },
    commands: {
      register(registration) {
        events.push(`register:${registration.command}`);
        assertExactKeys(registration, ["id", "label", "description", "command", "name", "slashName", "argumentHint", "priority"], "commands.register registration");
        assert.equal(typeof registration.id, "string", "commands.register id");
        assert.equal(typeof registration.label, "string", "commands.register label");
        assert.equal(typeof registration.command, "string", "commands.register command");
        calls.commandRegistrations.push(registration);
        return () => {};
      }
    },
    messages: {
      async list(request) {
        assertListRequest(request);
        events.push("messages.list");
        calls.lists.push(request);
        return options.messages ?? [{ id: "wo003-message-1", role: "user", content: "WO-003 test transcript" }];
      }
    },
    models: {
      async getStatus(request) {
        events.push("models.getStatus");
        assert.equal(request, "reviewer", "models.getStatus assignment");
        calls.modelStatuses.push(request);
        return createReviewerStatus(options);
      },
      async infer(request) {
        assertInferenceRequest(request);
        events.push("models.infer");
        calls.infer.push(request);
        if (options.inferError) throw options.inferError;
        if (options.deferInfer && calls.infer.length === 1) return options.deferInfer.promise;
        return options.inferTextOnly
          ? { text: JSON.stringify(STRUCTURED_REVIEW) }
          : { text: JSON.stringify(STRUCTURED_REVIEW), json: STRUCTURED_REVIEW };
      }
    },
    notifications: {
      async show(request) {
        assertNotification(request, "notifications.show request");
        events.push(`notification:${request.tone}:${request.title}`);
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
      chat: {
        async get(key) {
          events.push(`storage.chat.get:${key}`);
          return stored.get(key);
        },
        async set(key, value) {
          events.push(`storage.chat.set:${key}`);
          stored.set(key, value);
          calls.storageSets.push({ key, value, scope: "chat" });
        }
      },
      local: {
        async get(key) {
          events.push(`storage.get:${key}`);
          return stored.get(key);
        },
        async set(key, value) {
          events.push(`storage.set:${key}`);
          stored.set(key, value);
          calls.storageSets.push({ key, value });
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
        assertUiRequest(request, "ui.openContribution request");
        events.push(`ui.openContribution:${request.context?.review?.phase ?? "idle"}`);
        calls.opened.push(request);
        // Real-host semantics (Side Chat pattern): the open promise stays
        // pending while the user keeps the popup open.
        return new Promise(() => {});
      },
      async update(request) {
        events.push(`ui.update:${request.badge ?? ""}`);
        calls.chromeUpdates.push(request);
      },
      async updateSurface(request) {
        assertUiRequest(request, "ui.updateSurface request", { patch: true });
        events.push(`ui.updateSurface:${request.context?.review?.phase ?? "untitled"}`);
        calls.updates.push(request);
        return { updated: true, id: request.id, kind: request.kind };
      }
    }
  };

  return { msty, calls };
}

async function activateStrict(options = {}) {
  if (typeof moduleNamespace.activate !== "function") {
    throw new GateBlockedError("named module.activate is absent, so no documented returned-runtime seam exists");
  }
  const host = createHost(options);
  const runtime = await withDeadline(moduleNamespace.activate(host.msty), "named activation");
  if (typeof runtime?.run !== "function") {
    throw new GateBlockedError(`named activation did not return a callable run (received ${String(runtime)})`);
  }
  return { ...host, runtime };
}

async function activateCurrentDefault(options = {}) {
  const activate = moduleNamespace.default?.activate;
  assert.equal(typeof activate, "function", "baseline default activation path must remain characterizable");
  const host = createHost(options);
  const runtime = await withDeadline(activate(host.msty), "current default activation");
  return { ...host, runtime };
}

function workflowCounts(calls) {
  return {
    transcriptReads: calls.lists.length,
    inference: calls.infer.length,
    persistence: calls.storageSets.length,
    updates: calls.updates.length,
    notifications: calls.notifications.length,
    composerReads: calls.composerGets,
    composerClears: calls.composerClear,
    composerWrites: calls.composerSet.length
  };
}

async function waitForCondition(predicate, label, milliseconds = DEADLINE_MS) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new DeadlineError(`${label} exceeded ${milliseconds} ms deadline`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function assertVisibleError(calls, messagePattern, detailPattern) {
  const errorNotification = calls.notifications.find((item) => item.tone === "error");
  assert.ok(errorNotification, "T7 failure must emit a visible error notification");
  assert.match(errorNotification.body, messagePattern);
  // Re-pinned (rework t_464e32ac): the failure is visible in the isolated
  // review surface through the runner's `failed` lifecycle context push —
  // the same stage token, asserted here as its own property. The toast alone
  // no longer satisfies this clause.
  const failurePush = [...calls.updates, ...calls.opened].find((item) =>
    item.context?.review?.phase === "failed" && messagePattern.test(`diagnostic-stage=${item.context.review.failureStage ?? ""}`)
  );
  assert.ok(failurePush, "T7 failure must be visible in the isolated review surface (failed lifecycle context push)");
  // t_fa7ab623: the push must also carry WHY the stage failed. The token alone
  // is no longer the whole contract — a failure that only reproduces on the
  // host has to be reportable.
  const detail = failurePush.context.review.failureDetail;
  assert.equal(typeof detail, "string", "T7 failure push must preserve a reason for the failed stage");
  assert.equal(detail.trim().length > 0, true, "T7 preserved failure reason must be non-empty");
  assert.equal(detail.includes("\n"), false, "T7 preserved failure reason must be a single line");
  assert.equal(detail.length <= FAILURE_DETAIL_MAX_LENGTH, true, "T7 preserved failure reason must stay bounded");
  if (detailPattern) {
    assert.match(detail, detailPattern, "T7 preserved failure reason must name the underlying cause, not just the token");
  }
}

function assertStartBeforeTerminal(calls, terminalLevel) {
  const startIndex = calls.events.findIndex((event) => event === "notification:default:Review started");
  const terminalIndex = calls.events.findIndex((event) => event.startsWith(`notification:${terminalLevel}:`));
  assert.ok(startIndex >= 0, "T7 must emit a start event");
  assert.ok(terminalIndex > startIndex, `T7 ${terminalLevel} event must follow the start event`);
}

function assertClassifiedUnknownOutcome(outcome, command) {
  if (outcome.kind === "throw") {
    assert.match(outcome.message, /unknown command/i, "T5 rejection must explicitly classify an unknown command");
    assert.equal(
      outcome.message.includes(command),
      true,
      "T5 rejection must identify the exact unknown command"
    );
    return;
  }

  assert.ok(
    outcome.value && typeof outcome.value === "object" && !Array.isArray(outcome.value),
    "T5 non-throwing unknown-command result must be a structured object"
  );
  const classification = outcome.value.code ?? outcome.value.status ?? outcome.value.error?.code;
  assert.equal(classification, "UNKNOWN_COMMAND", "T5 structured result must classify UNKNOWN_COMMAND");
  assert.equal(outcome.value.command, command, "T5 structured result must identify the exact unknown command");
}

async function invokeRun(runtime, command, payload, args = []) {
  return withDeadline(runtime.run(command, payload, ...args), `runtime dispatch for ${command}`);
}

const gates = [
  {
    id: "T1",
    title: "Entry resolution",
    expectedBaseline: "PASS",
    async run() {
      const resolved = await resolvePackageEntry(PACKAGE_ROOT);
      assert.equal(resolved.manifestPath, MANIFEST_PATH);
      assert.equal(resolved.entryPath, entryPath);
      assert.equal(resolved.manifest.entry, manifest.entry);

      const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wo003-entry-"));
      try {
        const missingRoot = path.join(fixtureRoot, "missing-entry");
        await mkdir(missingRoot, { recursive: true });
        await writeFile(path.join(missingRoot, "manifest.json"), JSON.stringify({ entry: "absent.js" }));
        await assert.rejects(
          resolvePackageEntry(missingRoot),
          /Manifest entry does not resolve at package root: absent\.js/,
          "T1 must reject a manifest whose literal entry is missing"
        );

        const wrapperRoot = path.join(fixtureRoot, "wrapper");
        const nestedPackage = path.join(wrapperRoot, "nested-package");
        await mkdir(nestedPackage, { recursive: true });
        await writeFile(path.join(nestedPackage, "manifest.json"), JSON.stringify({ entry: "extension.js" }));
        await writeFile(path.join(nestedPackage, "extension.js"), "export function activate() {}\n");
        await assert.rejects(
          resolvePackageEntry(wrapperRoot),
          /Package root must contain a readable manifest\.json/,
          "T1 must reject a wrapper folder even when a nested package is valid"
        );
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  },
  {
    id: "T2",
    title: "Named activation export",
    expectedBaseline: "PASS",
    async run() {
      const defaultOnlyNamespace = { default: { activate() {} } };
      assert.equal(
        typeof defaultOnlyNamespace.activate,
        "undefined",
        "T2 default.activate alone must not satisfy named activation"
      );
      if (typeof moduleNamespace.activate !== "function") {
        assert.equal(
          typeof moduleNamespace.default?.activate,
          "function",
          "T2 baseline mismatch: neither named nor default activation is callable"
        );
        throw new DesignedRedError(
          `T2 expected named module.activate function; actual namespace exports: ${Object.keys(moduleNamespace).join(", ")}`
        );
      }
      assert.equal(
        typeof moduleNamespace.activate,
        "function",
        `T2 expected named module.activate function; actual namespace exports: ${Object.keys(moduleNamespace).join(", ")}`
      );
    }
  },
  {
    id: "T3",
    title: "Returned callable runtime",
    expectedBaseline: "PASS",
    async run() {
      const { runtime } = await activateCurrentDefault();
      assert.equal(
        typeof runtime?.run,
        "function",
        `T3 activation result must expose callable run; received ${String(runtime)}`
      );
      await invokeRun(runtime, runtimeCommand, "WO-003 bounded invocation");
    }
  },
  {
    id: "T4",
    title: "Manifest-derived known-command dispatch",
    expectedBaseline: "PASS",
    async run() {
      assert.equal(commandsProvidePermission?.required, true, "T4 commands.provide must be a required permission");
      assert.equal(commandContributions.length, 2, "T4 requires exactly the /review and /hermes-review-diagnose manifest command contributions");
      assert.equal(commandContributions[1]?.command, "hermes-review.diagnose", "T4 second contribution must be the diagnose command");
      assert.equal(typeof commandContributions[1]?.label, "string", "T4 diagnose contribution must carry a visible label");
      assert.equal(contribution.id, "review", "T4 contribution identity must be review");
      assert.equal(slashCommand, "/review", "T4 slash naming must resolve to /review");
      assert.equal(runtimeCommand, "hermes-review.run", "T4 runtime mapping must resolve to hermes-review.run");

      const { runtime } = await activateStrict();
      await withDeadline(runtime.run(runtimeCommand, "known-command-focus"), "T4 known-command dispatch");
      assert.equal(runtimeCommand, contribution.command, "T4 must deliver the manifest runtime command unchanged");
      const opened = await activateCurrentDefault();
      assert.equal(opened.calls.commandRegistrations.length, 1, "T4 must register one documented runtime-only reopen command");
      assert.equal(opened.calls.commandRegistrations[0].command, "hermes-review.open");
    }
  },
  {
    id: "T5",
    title: "Unknown-command handling",
    expectedBaseline: "PASS",
    async run() {
      const unknownCommand = `${runtimeCommand}.wo003-unknown`;
      const outcomes = [];
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const { runtime, calls } = await activateStrict();
        const before = workflowCounts(calls);
        let outcome;
        try {
          const value = await invokeRun(runtime, unknownCommand, { probe: "unknown-command" });
          outcome = { kind: "return", value };
        } catch (error) {
          if (error instanceof DeadlineError) throw error;
          outcome = { kind: "throw", name: error?.name ?? "Error", message: error?.message ?? String(error) };
        }
        assertClassifiedUnknownOutcome(outcome, unknownCommand);
        const after = workflowCounts(calls);
        assert.deepEqual(after, before, "T5 unknown command must cause zero inference, persistence, UI, notification, composer, or chat side effects");
        outcomes.push(outcome);
      }
      assert.deepEqual(outcomes[1], outcomes[0], "T5 unknown-command handling must be deterministic across equivalent isolated runtimes");
    }
  },
  {
    id: "T6",
    title: "Conservative payload boundary",
    expectedBaseline: "PASS",
    async run() {
      const cases = [
        { name: "undefined", payload: undefined, args: [] },
        { name: "null", payload: null, args: [] },
        { name: "string", payload: "wo003-string-instruction", args: [], instructionToken: "wo003-string-instruction" },
        { name: "object", payload: { topic: "wo003-object-token" }, args: [], forbiddenInstructionToken: "wo003-object-token" },
        { name: "array", payload: ["wo003-array-token", 2], args: [], forbiddenInstructionToken: "wo003-array-token" },
        { name: "number", payload: 42, args: [] },
        { name: "boolean", payload: false, args: [] },
        {
          name: "multiple-json-arguments",
          payload: { wo005PayloadProperty: "wo005-payload-token", nested: { value: 7 } },
          args: ["wo005-variadic-token", { wo005ArgProperty: "wo005-object-token" }, ["wo005-array-token", 8], false, null],
          forbiddenInstructionTokens: ["wo005-payload-token", "wo005PayloadProperty", "wo005-variadic-token", "wo005ArgProperty", "wo005-object-token", "wo005-array-token"]
        }
      ];

      const blockedCases = [];

      for (const testCase of cases) {
        let strictHost;
        try {
          strictHost = await activateStrict();
        } catch (error) {
          if (error instanceof GateBlockedError) {
            blockedCases.push({ name: testCase.name, reason: error.message });
            continue;
          }
          throw error;
        }
        const { runtime, calls } = strictHost;
        const delivered = [];
        const dispatch = (command, payload, ...args) => {
          delivered.push([command, payload, ...args]);
          return runtime.run(command, payload, ...args);
        };
        let outcome;
        try {
          outcome = { kind: "return", value: await withDeadline(
            dispatch(runtimeCommand, testCase.payload, ...testCase.args),
            `T6 ${testCase.name} dispatch`
          ) };
        } catch (error) {
          if (error instanceof DeadlineError) throw error;
          outcome = { kind: "throw", name: error?.name ?? "Error", message: error?.message ?? String(error) };
        }
        assert.deepEqual(
          delivered[0],
          [runtimeCommand, testCase.payload, ...testCase.args],
          `T6 ${testCase.name} must preserve JSON values and argument order at the runtime boundary`
        );
        assert.equal(
          outcome.kind,
          "return",
          `T6 ${testCase.name} is valid JSON input and must settle without rejection; received ${outcome.name ?? "unknown"}: ${outcome.message ?? "no message"}`
        );

        assert.equal(calls.infer.length, 1, `T6 ${testCase.name} must execute the known-command review exactly once`);
        const prompts = calls.infer
          .map((request) => request.messages?.find((message) => message.role === "user")?.content)
          .filter((prompt) => typeof prompt === "string");
        assert.equal(prompts.length, 1, `T6 ${testCase.name} must expose exactly one reviewer prompt`);
        if (testCase.instructionToken) {
          assert.equal(
            prompts.some((prompt) => prompt.includes(testCase.instructionToken)),
            true,
            "T6 documented string channel must remain available as reviewer instructions"
          );
        }
        if (testCase.forbiddenInstructionTokens) {
          const forbiddenPromptFragments = [
            ...testCase.forbiddenInstructionTokens,
            JSON.stringify(testCase.payload),
            JSON.stringify(testCase.args)
          ];
          for (const fragment of forbiddenPromptFragments) {
            assert.equal(
              prompts.some((prompt) => prompt.includes(fragment)),
              false,
              `T6 ${testCase.name} must not inject payload/variadic value or serialized wrapper fragment ${fragment}`
            );
          }
        }
      }

      if (blockedCases.length) {
        assert.equal(
          blockedCases.length,
          cases.length,
          "T6 baseline must record every payload case that cannot reach the runtime boundary"
        );
        throw new GateBlockedError(
          `T6 payload cases unable to reach runtime boundary: ${JSON.stringify(blockedCases)}`
        );
      }
    }
  },
  {
    id: "T7",
    title: "Visible failure and bounded observability",
    expectedBaseline: "PASS",
    async run() {
      const cases = [
        { name: "missing active chat", options: { currentChat: {} }, message: /diagnostic-stage=current-chat-lookup/, detail: /No active chat/, expectedInference: 0 },
        { name: "empty transcript", options: { messages: [] }, message: /diagnostic-stage=recent-message-retrieval/, detail: /No readable messages/, expectedInference: 0 },
        { name: "inference rejection", options: { inferError: new Error("wo003 isolated inference rejection") }, message: /diagnostic-stage=inference-request/, detail: /wo003 isolated inference rejection/, expectedInference: 1 }
      ];
      for (const testCase of cases) {
        const host = await activateStrict(testCase.options);
        await invokeRun(host.runtime, runtimeCommand, undefined);
        assertVisibleError(host.calls, testCase.message, testCase.detail);
        assertStartBeforeTerminal(host.calls, "error");
        assert.equal(host.calls.infer.length, testCase.expectedInference);
        assert.equal(host.calls.storageSets.length, 0);
        assert.equal(host.calls.composerSet.length, 0);

        await invokeRun(host.runtime, runtimeCommand, undefined);
        assert.equal(
          host.calls.events.filter((event) => event === "notification:default:Review started").length,
          2,
          `T7 ${testCase.name} must reset lifecycle state for a second bounded invocation`
        );
        assert.equal(
          host.calls.notifications.filter((item) => item.tone === "error").length,
          2,
          `T7 ${testCase.name} must remain visibly observable after lifecycle recovery`
        );
        assert.equal(host.calls.infer.length, testCase.expectedInference * 2);
        assert.equal(host.calls.storageSets.length, 0);
        assert.equal(host.calls.composerSet.length, 0);
      }

      const success = await activateStrict();
      await invokeRun(success.runtime, runtimeCommand, "wo003-success-observability");
      assertStartBeforeTerminal(success.calls, "success");
      assert.equal(success.calls.infer.length, 1);
      assert.equal(success.calls.storageSets.length, 1);
      assert.equal(success.calls.infer[0].modelAssignment, "reviewer", "ready+configured reviewer must be assigned");
      // Card D: the drawer render patch is gone; the reviewer-model label is
      // observable in the persisted per-chat history entry instead.
      assert.match(
        success.calls.storageSets[0].value?.entries?.[0]?.modelLabel ?? "",
        /your reviewer model\.$|your reviewer model$/,
        "ready+configured reviewer label"
      );
      assert.equal(success.calls.composerSet.length, 0, "T7 success must not insert or auto-send chat content");

      const fallback = await activateStrict({
        reviewerStatus: { ready: false, configured: false, source: "unavailable", modelAssignment: "reviewer" }
      });
      await invokeRun(fallback.runtime, runtimeCommand);
      assert.equal("modelAssignment" in fallback.calls.infer[0], false, "unready reviewer must omit modelAssignment");
      assert.match(fallback.calls.storageSets[0].value?.entries?.[0]?.modelLabel ?? "", /the current chat model\.$|the current chat model$/, "unready reviewer label");

      const configuredFallback = await activateStrict({
        reviewerStatus: { ready: true, configured: true, source: "fallback", modelAssignment: "reviewer" }
      });
      await invokeRun(configuredFallback.runtime, runtimeCommand);
      assert.equal("modelAssignment" in configuredFallback.calls.infer[0], false, "ready+configured fallback must omit modelAssignment");
      assert.match(configuredFallback.calls.storageSets[0].value?.entries?.[0]?.modelLabel ?? "", /the current chat model\.$|the current chat model$/, "ready+configured fallback label");

      const readyButUnconfigured = await activateStrict({
        reviewerStatus: { ready: true, configured: false, source: "fallback", modelAssignment: "reviewer" }
      });
      await invokeRun(readyButUnconfigured.runtime, runtimeCommand);
      assert.equal("modelAssignment" in readyButUnconfigured.calls.infer[0], false, "ready+unconfigured reviewer must omit modelAssignment");
      assert.match(readyButUnconfigured.calls.storageSets[0].value?.entries?.[0]?.modelLabel ?? "", /the current chat model\.$|the current chat model$/, "ready+unconfigured reviewer label");

      const undefinedSource = await activateStrict({
        reviewerStatus: { ready: true, configured: true, source: undefined, modelAssignment: "reviewer" }
      });
      await invokeRun(undefinedSource.runtime, runtimeCommand);
      assert.equal("modelAssignment" in undefinedSource.calls.infer[0], false, "undefined source must omit modelAssignment");
      assert.match(undefinedSource.calls.storageSets[0].value?.entries?.[0]?.modelLabel ?? "", /the current chat model\.$|the current chat model$/, "undefined source fallback label");

      const unknownSource = await activateStrict({
        reviewerStatus: { ready: true, configured: true, source: "unknown", modelAssignment: "reviewer" }
      });
      await invokeRun(unknownSource.runtime, runtimeCommand);
      assert.equal("modelAssignment" in unknownSource.calls.infer[0], false, "unknown source must omit modelAssignment");
      assert.match(unknownSource.calls.storageSets[0].value?.entries?.[0]?.modelLabel ?? "", /the current chat model\.$|the current chat model$/, "unknown source fallback label");

      const textOnly = await activateStrict({ inferTextOnly: true });
      await invokeRun(textOnly.runtime, runtimeCommand);
      assert.equal(textOnly.calls.storageSets[0].value?.entries?.[0]?.summary, "No material issues found.", "text-only result must apply the prompt fallback and persist");
      assert.equal(textOnly.calls.notifications.at(-1).tone, "success", "text-only result must complete successfully");
    }
  },
  {
    id: "H2",
    title: "Overlapping invocation and lifecycle reset",
    expectedBaseline: "PASS",
    async run() {
      const inference = deferred();
      const host = await withDeadline(activateStrict({ deferInfer: inference }), "H2 isolated runtime setup");
      const first = invokeRun(host.runtime, runtimeCommand, undefined);
      await waitForCondition(
        () => host.calls.infer.length === 1,
        "H2 first inference setup"
      );
      assert.equal(
        host.calls.events.filter((event) => event === "notification:default:Review started").length,
        1,
        "H2 first invocation must start exactly one review workflow before overlap"
      );

      const beforeOverlap = workflowCounts(host.calls);
      await withDeadline(
        invokeRun(host.runtime, runtimeCommand, "ignored-while-running"),
        "H2 overlapping invocation"
      );
      assert.equal(host.calls.infer.length, 1, "H2 overlapping invocation must not start another inference");
      assert.equal(
        host.calls.events.filter((event) => event === "notification:default:Review started").length,
        1,
        "H2 overlapping invocation must not start another review workflow"
      );
      assert.equal(host.calls.lists.length, beforeOverlap.transcriptReads, "H2 overlap must not reread the transcript");
      assert.equal(host.calls.storageSets.length, beforeOverlap.persistence, "H2 overlap must not persist a second result");
      assert.equal(
        host.calls.notifications.filter((item) => item.tone === "success" || item.tone === "error").length,
        0,
        "H2 overlap must not emit a success/error terminal event before the first inference settles"
      );
      assert.equal(host.calls.opened.length, 1, "H2 overlap must not open a second pane surface");
      assert.equal(host.calls.opened[0].context?.review?.phase, "running", "H2 open request carries the running phase");
      assert.equal(
        host.calls.updates.some((item) => item.context?.review?.phase === "running" && item.context.review.instruction === "ignored-while-running"),
        true,
        "H2 overlap re-surfaces the running phase (never toggles the progress pane closed)"
      );

      inference.resolve({ text: JSON.stringify(STRUCTURED_REVIEW), json: STRUCTURED_REVIEW });
      await withDeadline(first, "H2 first invocation settlement");
      assert.equal(host.calls.infer.length, 1, "H2 first settlement must complete the single inference");
      assert.equal(host.calls.storageSets.length, 1, "H2 completion must persist exactly once");
      assert.equal(
        host.calls.notifications.filter((item) => item.tone === "success").length,
        1,
        "H2 completion must emit exactly one success terminal event"
      );
      assert.equal(
        host.calls.notifications.filter((item) => item.tone === "error").length,
        0,
        "H2 completion must not emit an error terminal event"
      );

      await withDeadline(
        invokeRun(host.runtime, runtimeCommand, "fresh-after-completion"),
        "H2 post-completion invocation"
      );
      assert.equal(host.calls.infer.length, 2, "H2 lifecycle reset must permit a fresh second inference");
      assert.equal(
        host.calls.events.filter((event) => event === "notification:default:Review started").length,
        2,
        "H2 lifecycle reset must permit a fresh second workflow start"
      );
      assert.equal(host.calls.storageSets.length, 2, "H2 fresh workflow must persist exactly one additional result");
      assert.equal(
        host.calls.notifications.filter((item) => item.tone === "success").length,
        2,
        "H2 fresh workflow must emit exactly one additional success terminal event"
      );
    }
  },
  {
    id: "T8",
    title: "Preserve seven existing scenarios",
    expectedBaseline: "PASS",
    async run() {
      const bytes = await readFile(EXISTING_HARNESS_PATH);
      assert.equal(sha256(bytes), EXISTING_HARNESS_SHA256, "T8 existing harness must remain byte-identical to the accepted snapshot");
      const result = spawnSync(process.execPath, [EXISTING_HARNESS_PATH], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        timeout: 5_000
      });
      assert.equal(result.error, undefined, `T8 existing harness process error: ${result.error?.message ?? "none"}`);
      assert.equal(result.status, 0, `T8 existing harness exited ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /Hermes Review contract checks passed \(7 scenarios\)\./);
    }
  }
];

const results = [];
for (const gate of gates) {
  try {
    await gate.run();
    results.push({ gate: gate.id, title: gate.title, status: "PASS", expectedBaseline: gate.expectedBaseline });
    console.log(`[PASS][${gate.id}] ${gate.title}`);
  } catch (error) {
    let status;
    if (error instanceof GateBlockedError) status = "BLOCKED_DOWNSTREAM";
    else if (error instanceof DesignedRedError) status = "DESIGNED_RED";
    else status = "UNEXPECTED_FAILURE";
    const message = error?.message ?? String(error);
    const matchesExpectedBaseline = status === gate.expectedBaseline;
    const reportedStatus = matchesExpectedBaseline ? status : "UNEXPECTED_FAILURE";
    const reportedMessage = matchesExpectedBaseline
      ? message
      : `${message} (observed ${status}; expected baseline ${gate.expectedBaseline})`;
    results.push({
      gate: gate.id,
      title: gate.title,
      status: reportedStatus,
      expectedBaseline: gate.expectedBaseline,
      error: reportedMessage
    });
    console.error(`[${reportedStatus}][${gate.id}] ${gate.title}: ${reportedMessage}`);
  }
}

console.log(`WO003_RESULT_MATRIX=${JSON.stringify(results)}`);
const nonPassing = results.filter((result) => result.status !== "PASS");
console.log(`Corrective lifecycle contract: ${results.length - nonPassing.length} passed, ${nonPassing.length} non-passing gate(s).`);
if (nonPassing.length) process.exitCode = 1;
