import assert from "node:assert/strict";
import extension from "../hermes-review-extension/extension.js";

const STRUCTURED_REVIEW = {
  summary: "Two concrete issues need correction.",
  issues: [
    {
      severity: "High",
      title: "Unsupported current-events claim",
      location: "Message 2, opening paragraph",
      problem: "The response presents a time-sensitive claim without a directly identifiable source.",
      correction: "Link a current article and state its publication time, or mark the claim unverified."
    },
    {
      severity: "Medium",
      title: "Ambiguous policy description",
      location: "Message 2, fuel-price bullet",
      problem: "Two different measures appear to be conflated.",
      correction: "Separate the measures and explain their status and effective dates."
    }
  ]
};

function assertExactKeys(value, allowed, label) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  assert.deepEqual(unexpected, [], `${label} contains undocumented fields: ${unexpected.join(", ")}`);
}

function assertContent(content, label) {
  assert.equal(Array.isArray(content), true, `${label} content must be an array`);
  for (const [index, block] of content.entries()) {
    assert.equal(typeof block?.type, "string", `${label} block ${index} must have a type`);
    if (block.type === "callout") {
      assertExactKeys(block, ["type", "title", "body", "tone"], `${label} callout ${index}`);
      assert.equal(typeof block.title, "string", `${label} callout ${index} title`);
      assert.equal(typeof block.body, "string", `${label} callout ${index} body`);
      continue;
    }
    if (block.type === "text") {
      assertExactKeys(block, ["type", "text", "title", "tone"], `${label} text ${index}`);
      assert.equal(typeof block.text, "string", `${label} text ${index} text`);
      continue;
    }
    if (block.type === "progress") {
      assertExactKeys(block, ["type", "title", "label", "value", "max", "description", "tone"], `${label} progress ${index}`);
      assert.equal(typeof block.value, "number", `${label} progress ${index} value`);
      continue;
    }
    assert.equal(block.type, "divider", `${label} contains unsupported block type ${block.type}`);
    assertExactKeys(block, ["type"], `${label} divider ${index}`);
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

function assertStatusRequest(request) {
  assert.equal(request, "reviewer", "models.getStatus must use the documented reviewer assignment ID");
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

function assertInferenceRequest(request) {
  assertExactKeys(request, ["messages", "modelAssignment", "responseFormat"], "models.infer request");
  assert.equal(Array.isArray(request.messages), true, "models.infer messages");
  assert.deepEqual(request.messages.map((message) => message.role), ["system", "user"], "models.infer roles");
  assert.equal(request.messages.every((message) => typeof message.content === "string"), true, "models.infer message content");
  assert.equal(request.modelAssignment === undefined || request.modelAssignment === "reviewer", true, "models.infer assignment");
  assertExactKeys(request.responseFormat, ["type", "name", "schema", "strict"], "models.infer responseFormat");
  assert.equal(request.responseFormat.type, "json", "models.infer responseFormat type");
}

function createMock(options = {}) {
  const calls = {
    notifications: [],
    lists: [],
    infer: [],
    modelStatuses: [],
    opened: [],
    closed: [],
    updates: [],
    updatesChrome: [],
    composerSet: [],
    composerClear: 0,
    workspaceItems: [],
    storageSets: [],
    chatSets: [],
    commandRegistrations: []
  };
  const handlers = new Map();
  const openResolvers = [];
  const stored = new Map();
  if (options.storedReview) stored.set("latest-review", options.storedReview);
  // storage.chat backing so activation-time history bootstrap behaves like the host.
  if (!options.noChatStorage) {
    stored.set("__chat__", new Map());
  }

  const msty = {
    context: {
      async getCurrentChat() {
        return options.currentChat ?? { chat: { id: "chat-current" }, messages: [] };
      }
    },
    commands: {
      register(registration) {
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
        calls.lists.push(request);
        return options.messages ?? [
          { id: "message-current-2", role: "assistant", content: "Second answer" },
          { id: "message-current-1", role: "user", content: "First request" }
        ];
      }
    },
    models: {
      async getStatus(request) {
        assertStatusRequest(request);
        calls.modelStatuses.push(request);
        return createReviewerStatus(options);
      },
      async infer(request) {
        assertInferenceRequest(request);
        calls.infer.push(request);
        if (options.inferError) throw options.inferError;
        if (options.deferInfer) return options.deferInfer.promise;
        const result = options.inferContent ?? STRUCTURED_REVIEW;
        return options.inferTextOnly
          ? { text: JSON.stringify(result) }
          : { text: JSON.stringify(result), json: result };
      }
    },
    notifications: {
      async show(request) {
        assertNotification(request, "notifications.show request");
        calls.notifications.push(request);
      }
    },
    composer: {
      async get() {
        return { text: options.composerText ?? "/review", canEdit: true };
      },
      async clear() {
        calls.composerClear += 1;
      },
      async setText(text) {
        calls.composerSet.push(text);
      }
    },
    storage: {
      local: {
        async get(key) {
          return stored.get(key);
        },
        async set(key, value) {
          stored.set(key, value);
          calls.storageSets.push({ key, value });
        }
      },
      ...(options.noChatStorage ? {} : {
        chat: (() => {
          const chatData = /** @type {Map<any, any>} */ (stored.get("__chat__"));
          return {
            async get(key) {
              return chatData.get(key);
            },
            async set(key, value) {
              chatData.set(key, value);
              calls.chatSets.push({ key, value });
            }
          };
        })()
      })
    },
    ui: {
      registerWorkspaceItem(item) {
        assertExactKeys(item, ["id", "title", "label", "description", "icon", "when", "command", "tooltip", "surface", "priority"], "ui.registerWorkspaceItem registration");
        if (options.workspaceRegistrationError) throw options.workspaceRegistrationError;
        calls.workspaceItems.push(item);
      },
      openContribution(request) {
        assertExactKeys(request, ["id", "title", "body", "content", "closeLabel", "context", "contextSync", "headerActions"], "ui.openContribution request");
        // t_9622dfc8 item B: the pane is a DECLARED popup contribution, opened by
        // its contribution id with NO `kind` (guide:1098-1122: `kind` is optional
        // when the id is unique across the declared overlays).
        assert.equal("kind" in request, false, "ui.openContribution opens the declared contribution without kind");
        assert.equal(request.id, "hermes-review-pane", "ui.openContribution id targets the pane contribution");
        calls.opened.push(request);
        if (options.openContributionError) throw options.openContributionError;
        return new Promise((resolve) => openResolvers.push(resolve));
      },
      async openPopup(request) {
        assertExactKeys(request, ["id", "title", "closeLabel"], "ui.openPopup fallback request");
        assert.equal(request.id, "hermes-review-pane", "ui.openPopup fallback id");
        calls.opened.push(request);
        return new Promise((resolve) => openResolvers.push(resolve));
      },
      async closeSurface(request) {
        assertExactKeys(request, ["kind", "id", "result"], "ui.closeSurface request");
        assert.equal(request.kind, "popup", "ui.closeSurface kind");
        assert.equal(request.id, "hermes-review-pane", "ui.closeSurface id");
        calls.closed.push(request);
        return options.closeSurfaceResult ?? { closed: true, id: request.id, kind: request.kind };
      },
      update(request) {
        assertExactKeys(request, ["id", "surface", "badge", "tone", "hidden", "disabled", "disabledReason", "tooltip", "summary", "detail", "actionLabel", "shortcut", "shortcutHint"], "ui.update request");
        assert.equal(request.surface, "titleBar", "ui.update surface");
        calls.updatesChrome.push(request);
      },
      async updateSurface(request) {
        assertExactKeys(request, ["id", "kind", "title", "content", "headerActions"], "ui.updateSurface request");
        assert.equal(request.kind, "popup", "ui.updateSurface kind");
        calls.updates.push(request);
        return { updated: options.surfaceUpdated ?? true, id: request.id, kind: request.kind };
      }
    }
  };

  return { msty, calls, handlers, openResolvers };
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

function assertNoChatInsertion(mock) {
  assert.equal("create" in mock.msty.messages, false);
  assert.equal("append" in mock.msty.messages, false);
  assert.equal("startRun" in (mock.msty.chats ?? {}), false);
}

{
  const mock = createMock({
    currentChat: { chat: { id: "chat-from-snapshot" }, messages: [] },
    composerText: "/review focus on citations"
  });
  const runtime = await extension.activate(mock.msty);
  await runtime.run("hermes-review.run", "focus on citations");

  assert.equal(mock.calls.lists[0].chatId, "chat-from-snapshot");
  assert.equal(mock.calls.lists[0].order, "desc");
  assert.equal(mock.calls.composerClear, 1);
  assert.equal(mock.calls.infer[0].modelAssignment, "reviewer");
  assert.equal("providerId" in mock.calls.infer[0], false);
  assert.equal("modelId" in mock.calls.infer[0], false);
  assert.equal(mock.calls.infer[0].responseFormat.type, "json");
  assert.match(mock.calls.infer[0].messages[1].content, /Message 1 \(User\):\nFirst request/);
  assert.match(mock.calls.infer[0].messages[1].content, /Additional reviewer instruction/);
  // Auto-open: the review opens the pane by its DECLARED popup contribution id,
  // without `kind` (t_9622dfc8 item B).
  assert.equal(mock.calls.opened.length, 1);
  assert.equal("kind" in mock.calls.opened[0], false);
  assert.equal(mock.calls.opened[0].id, "hermes-review-pane");
  assert.equal(mock.calls.noChat ? true : mock.calls.chatSets.length, 1, "completed review is persisted to chat history");
  assert.equal(mock.calls.updatesChrome.length, 1, "launcher badge is updated after persistence");
  assert.equal(mock.calls.updatesChrome[0].badge, "1");
  assert.equal(mock.calls.workspaceItems[0].command, "hermes-review.openPane");
  assert.equal(mock.calls.commandRegistrations[0].command, "hermes-review.open");
  assert.equal(mock.calls.notifications.at(-1).tone, "success");
  assertNoChatInsertion(mock);

  const fallbackMock = createMock({
    reviewerStatus: { ready: false, configured: false, source: "unavailable", modelAssignment: "reviewer" }
  });
  const fallbackRuntime = await extension.activate(fallbackMock.msty);
  await fallbackRuntime.run("hermes-review.run");
  assert.equal("modelAssignment" in fallbackMock.calls.infer[0], false);

  const readyButFallbackMock = createMock({
    reviewerStatus: { ready: true, configured: true, source: "fallback", modelAssignment: "reviewer" }
  });
  const readyButFallbackRuntime = await extension.activate(readyButFallbackMock.msty);
  await readyButFallbackRuntime.run("hermes-review.run");
  assert.equal("modelAssignment" in readyButFallbackMock.calls.infer[0], false);

  const readyButUnconfiguredMock = createMock({
    reviewerStatus: { ready: true, configured: false, source: "fallback", modelAssignment: "reviewer" }
  });
  const readyButUnconfiguredRuntime = await extension.activate(readyButUnconfiguredMock.msty);
  await readyButUnconfiguredRuntime.run("hermes-review.run");
  assert.equal("modelAssignment" in readyButUnconfiguredMock.calls.infer[0], false);

  const undefinedSourceMock = createMock({
    reviewerStatus: { ready: true, configured: true, source: undefined, modelAssignment: "reviewer" }
  });
  const undefinedSourceRuntime = await extension.activate(undefinedSourceMock.msty);
  await undefinedSourceRuntime.run("hermes-review.run");
  assert.equal("modelAssignment" in undefinedSourceMock.calls.infer[0], false);

  const unknownSourceMock = createMock({
    reviewerStatus: { ready: true, configured: true, source: "unknown", modelAssignment: "reviewer" }
  });
  const unknownSourceRuntime = await extension.activate(unknownSourceMock.msty);
  await unknownSourceRuntime.run("hermes-review.run");
  assert.equal("modelAssignment" in unknownSourceMock.calls.infer[0], false);

  const textOnlyMock = createMock({ inferTextOnly: true });
  const textOnlyRuntime = await extension.activate(textOnlyMock.msty);
  await textOnlyRuntime.run("hermes-review.run");
  assert.equal(textOnlyMock.calls.chatSets.length, 1, "text-only result persists successfully");
  assert.equal(textOnlyMock.calls.notifications.at(-1).tone, "success");
}

{
  const gate = deferred();
  const mock = createMock({ deferInfer: gate, surfaceUpdated: false });
  const runtime = await extension.activate(mock.msty);
  const run = runtime.run("hermes-review.run");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Overlapping invocation while running: the pane opens exactly once.
  assert.equal(mock.calls.opened.length, 1);
  gate.resolve({ text: JSON.stringify(STRUCTURED_REVIEW), json: STRUCTURED_REVIEW });
  await run;

  assert.equal(mock.calls.chatSets.length, 1);
  assert.equal(mock.calls.opened.length, 1, "a running review opens the pane once, not per call");
}

{
  const mock = createMock({
    currentChat: { chat: null, chatId: "chat-from-compatibility-fallback" },
    surfaceUpdated: true
  });
  const runtime = await extension.activate(mock.msty);
  await runtime.run("hermes-review.run");
  assert.equal(mock.calls.lists[0].chatId, "chat-from-compatibility-fallback");
}

{
  const mock = createMock({ currentChat: {} });
  const runtime = await extension.activate(mock.msty);
  await runtime.run("hermes-review.run");
  assert.equal(mock.calls.notifications.at(-1).tone, "error");
  assert.match(mock.calls.notifications.at(-1).body, /diagnostic-stage=current-chat-lookup/);
  // The pane still opened (auto-open), and nothing was persisted on failure.
  assert.equal(mock.calls.opened.length, 1);
  assert.equal(mock.calls.chatSets.length, 0);
}

{
  const mock = createMock({ noChatStorage: true });
  const runtime = await extension.activate(mock.msty);
  // Toggle-close: the second open command closes the already-open pane.
  await runtime.run("hermes-review.openPane");
  await runtime.run("hermes-review.openPane");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.calls.opened.length, 1, "first invocation opens the pane");
  assert.equal(mock.calls.closed.length, 1, "second invocation closes the open pane");
  assert.deepEqual(mock.calls.closed[0].result, { dismissed: true });

  // `closed: false` recovery: the host lost the popup, so the guard resets
  // and the pane reopens.
  const staleMock = createMock({ noChatStorage: true, closeSurfaceResult: { closed: false, id: "hermes-review-pane", kind: "popup" } });
  const staleRuntime = await extension.activate(staleMock.msty);
  await staleRuntime.run("hermes-review.openPane");
  await staleRuntime.run("hermes-review.openPane");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleMock.calls.closed.length, 1);
  assert.equal(staleMock.calls.opened.length, 2, "closed:false clears stale state and reopens the pane");
}

{
  const mock = createMock({ messages: [] });
  const runtime = await extension.activate(mock.msty);
  await runtime.run("hermes-review.run");
  assert.equal(mock.calls.infer.length, 0);
  assert.equal(mock.calls.notifications.at(-1).tone, "error");
  assert.match(mock.calls.notifications.at(-1).body, /diagnostic-stage=recent-message-retrieval/);
}

{
  const mock = createMock({ workspaceRegistrationError: new Error("ui.workspace unavailable") });
  const runtime = await extension.activate(mock.msty);
  assert.equal(typeof runtime.run, "function");
  await runtime.run("hermes-review.run");
  assert.equal(mock.calls.notifications.at(-1).tone, "success");
}

console.log("Hermes Review contract checks passed (7 scenarios).");
