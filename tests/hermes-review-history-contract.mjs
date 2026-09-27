import assert from "node:assert/strict";
import extension from "../hermes-review-extension/extension.js";
import {
  HISTORY_SCHEMA_VERSION,
  HISTORY_STORAGE_KEY,
  appendReview,
  clearReviews,
  deleteReview,
  ensureHistory,
  listReviews,
  readReviewsNewestFirst,
  sendReviewToComposer,
  reportPersistenceFailure,
  updateReviewBody
} from "../hermes-review-extension/review-history.js";
import {
  FAILURE_DETAIL_MAX_LENGTH,
  REVIEW_SCHEMA,
  REVISION_FRAMING,
  TITLE_MAX_LENGTH,
  executeReview,
  fallbackReviewTitle,
  normalizeReview
} from "../hermes-review-extension/review-core.js";

const REVIEW_COMMAND = "hermes-review.run";

function assertExactKeys(value, allowed, label) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  assert.deepEqual(unexpected, [], `${label} contains undocumented fields: ${unexpected.join(", ")}`);
}

function assertNotification(request, label) {
  assertExactKeys(request, ["title", "body", "tone", "durationMs"], label);
  assert.equal(typeof request.title, "string", `${label} title`);
  assert.equal(typeof request.durationMs, "number", `${label} durationMs must be explicit on every toast`);
  assert.equal(Number.isFinite(request.durationMs) && request.durationMs > 0, true, `${label} durationMs must be a positive duration`);
  if (request.body !== undefined) {
    assert.equal(typeof request.body, "string", `${label} body`);
    if (request.tone !== "error" && !request.body.startsWith("diagnostic-stage=")) {
      assert.equal(/[.!?;]\s/.test(request.body.trim()), false, `${label} body must be single-clause`);
    }
  }
}

/**
 * Strict synthetic host: exact-key modelled surface, storage.local plus a
 * storage.chat stub with injectable rejection behavior.
 */
function createHost(options = {}) {
  const calls = {
    notifications: [],
    composerSet: [],
    storageLocalSets: [],
    storageChatSets: [],
    infer: []
  };
  const local = new Map();
  const chat = new Map();
  if (options.legacyReview) local.set("latest-review", options.legacyReview);
  if (options.prefilledChat) chat.set(HISTORY_STORAGE_KEY, options.prefilledChat);

  let chatSetAttempts = 0;
  const chatRejectionSchedule = options.chatRejectionSchedule ?? [];

  const msty = {
    context: {
      async getCurrentChat() {
        return options.currentChat ?? { chat: { id: "history-chat" } };
      }
    },
    commands: {
      register() {}
    },
    messages: {
      async list() {
        return options.messages ?? [
          { id: "m2", role: "assistant", content: "Second answer" },
          { id: "m1", role: "user", content: "First request" }
        ];
      }
    },
    models: {
      async getStatus() {
        return options.reviewerStatus ?? { ready: true, configured: true, source: "assignment" };
      },
      async infer(request) {
        calls.infer.push(request);
        if (options.inferResponse) return options.inferResponse;
        return { text: JSON.stringify(options.inferJson ?? { summary: "s", issues: [] }), json: options.inferJson ?? { summary: "s", issues: [] } };
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
        return { text: "/review", canEdit: true };
      },
      async clear() {},
      async setText(text) {
        calls.composerSet.push(text);
      }
    },
    storage: {
      local: {
        async get(key) {
          return local.get(key);
        },
        async set(key, value) {
          calls.storageLocalSets.push({ key, value });
          local.set(key, value);
        }
      },
      chat: {
        async get(key) {
          return chat.get(key);
        },
        async set(key, value) {
          chatSetAttempts += 1;
          if (chatRejectionSchedule.length && chatRejectionSchedule[0] >= chatSetAttempts) {
            chatRejectionSchedule.shift();
            throw options.chatRejectionError ?? new Error("maxValueBytes exceeded");
          }
          calls.storageChatSets.push({ key, value });
          chat.set(key, value);
        },
        async migrate(request) {
          // Mirrors the documented host behavior: apply the callback to the
          // stored object (or defaults) and store the result.
          const current = chat.get(request.key);
          const value = current ?? { ...(request.defaults ?? {}) };
          if (typeof request.migrate === "function") {
            const replacement = request.migrate(value, { key: request.key, scope: "chat", fromVersion: 0, toVersion: request.targetVersion, versionField: "schemaVersion", isNew: !current });
            const finalValue = replacement ?? value;
            chat.set(request.key, finalValue);
            return { version: request.targetVersion, targetVersion: request.targetVersion, previousVersion: 0, migrated: true, value: finalValue, key: request.key, scope: "chat", fromVersion: 0, versionField: "schemaVersion", isNew: !current };
          }
          return { version: request.targetVersion, targetVersion: request.targetVersion, previousVersion: 0, migrated: false, value, key: request.key, scope: "chat", fromVersion: 0, versionField: "schemaVersion", isNew: !current };
        }
      }
    },
    ui: {
      registerWorkspaceItem() {},
      async openDrawer() {
        return { closed: true };
      },
      async updateSurface(request) {
        calls.updates = calls.updates ?? [];
        calls.updates.push(request);
        return { updated: options.surfaceUpdated ?? true, id: request.id, kind: request.kind };
      }
    }
  };
  return { msty, calls, chat, local };
}

function makeReview(title, issueCount = 1) {
  return {
    ...(title !== undefined ? { title } : {}),
    summary: `${issueCount} issue${issueCount === 1 ? "" : "s"} found.`,
    issues: Array.from({ length: issueCount }, (_, index) => ({
      severity: index === 0 ? "High" : "Low",
      title: `Issue ${index + 1}`,
      location: `Message ${index + 1}`,
      problem: "Problem text.",
      correction: "Correction text."
    }))
  };
}

function makeMeta(messageCount = 2) {
  return { messageCount, modelLabel: "your reviewer model", completedAt: "2026-09-21T10:00:00.000Z" };
}

// HT1 — reviewer schema: title present / missing / non-string → fallback path.
{
  const schemaTitle = REVIEW_SCHEMA.properties.title;
  assert.equal(REVIEW_SCHEMA.required.includes("title"), true, "title must be required in the strict reviewer schema");
  assert.equal(REVIEW_SCHEMA.additionalProperties, false, "REVIEW_SCHEMA must stay strict");
  assert.equal(schemaTitle.maxLength, TITLE_MAX_LENGTH, "schema title must be capped at the title max length");

  const present = normalizeReview(makeReview("Citation gaps in the market summary"));
  assert.equal(present.title, "Citation gaps in the market summary");

  const missing = normalizeReview(makeReview(undefined, 2));
  assert.equal(missing.title, fallbackReviewTitle(missing.issues), "missing title falls back deterministically");
  assert.match(missing.title, /^Review found 2 issues$/);

  const nonString = normalizeReview(makeReview(42));
  assert.equal(nonString.title, fallbackReviewTitle(nonString.issues), "non-string title falls back deterministically");

  const blank = normalizeReview(makeReview("   "));
  assert.equal(blank.title, fallbackReviewTitle(blank.issues), "blank title falls back deterministically");

  const long = normalizeReview(makeReview("x".repeat(200)));
  assert.equal(long.title.length, TITLE_MAX_LENGTH, "over-long title is clamped");

  const empty = normalizeReview({ summary: "No material issues found.", issues: [] });
  assert.equal(empty.title, "Review found no issues");
  console.log("[PASS][HT1] Reviewer schema title present / missing / non-string fallback");
}

// HT2 — history store against a storage.chat stub: append, list ordering.
{
  const host = createHost();
  await ensureHistory(host.msty, "history-chat"); // fresh chat starts empty
  const first = await appendReview(host.msty, makeReview("First review title"), makeMeta(2), "history-chat");
  assert.equal(first.persisted, true);
  const second = await appendReview(host.msty, makeReview("Second review title"), { ...makeMeta(3), completedAt: "2026-09-21T11:00:00.000Z" }, "history-chat");
  assert.equal(second.persisted, true);

  // t_61dd1e7e round 2: the composite per-chat key (B3) — one document per
  // chat under `review-history:<chatId>`, never a shared single key.
  const stored = host.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`);
  assert.ok(stored, "the chat's document is stored under its composite key");
  assert.equal(host.chat.get(HISTORY_STORAGE_KEY), undefined, "no document is ever written to the un-suffixed legacy key");
  assert.equal(stored.schemaVersion, HISTORY_SCHEMA_VERSION, "stored document carries schemaVersion");
  assert.equal(stored.chatId, "history-chat", "appended entries carry the active chat id in the document");
  const ids = stored.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "entry ids are unique");
  assert.equal(stored.entries[0].title, "Second review title", "append stores newest first");
  assert.deepEqual(
    stored.entries.map((entry) => entry.title),
    ["Second review title", "First review title"]
  );
  for (const entry of stored.entries) {
    // t_db84b23e adds ONE additive field: `editedBody` (the user's edited review
    // body, or null). The list stays exact-keys-checked, so a new stored field
    // can never appear without this line changing with it.
    assertExactKeys(entry, ["id", "title", "createdAt", "messageCount", "modelLabel", "summary", "editedBody", "chatId", "issues"], "history entry");
    assert.equal(entry.editedBody, null, "an unedited entry carries the additive field as null, never \"\"");
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.title, "string");
    assert.equal(typeof entry.createdAt, "string");
    assert.equal(typeof entry.messageCount, "number");
    assert.equal(typeof entry.modelLabel, "string");
    assert.equal(typeof entry.summary, "string");
    assert.equal(entry.chatId, "history-chat", "every persisted entry carries its owning chat id");
    assert.equal(Array.isArray(entry.issues), true);
    for (const issue of entry.issues) {
      assertExactKeys(issue, ["severity", "title", "location", "problem", "correction"], "history issue");
    }
  }

  const listed = await listReviews(host.msty, "history-chat");
  assert.deepEqual(listed.map((entry) => entry.title), ["Second review title", "First review title"], "list returns newest first");

  const sorted = await readReviewsNewestFirst(host.msty, "history-chat");
  assert.deepEqual(sorted.map((entry) => entry.title), listed.map((entry) => entry.title));

  // No raw transcript is ever stored.
  assert.equal(JSON.stringify(stored).includes("First request"), false, "stored history must not contain the raw transcript");
  assert.equal(JSON.stringify(stored).includes("Second answer"), false, "stored history must not contain the raw transcript");
  console.log("[PASS][HT2] History append / list ordering / normalized entries only (composite per-chat key)");
}

// HT3 — delete one, clear all.
{
  const host = createHost();
  const first = await appendReview(host.msty, makeReview("First"), makeMeta(), "history-chat");
  await appendReview(host.msty, makeReview("Second"), { ...makeMeta(), completedAt: "2026-09-21T11:00:00.000Z" }, "history-chat");

  await deleteReview(host.msty, first.entries[0].id, "history-chat");
  const afterDelete = host.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`);
  assert.deepEqual(afterDelete.entries.map((entry) => entry.title), ["Second"], "delete removes exactly the targeted entry");

  // Deleting an unknown id is a no-op that does not rewrite storage.
  const setsBefore = host.calls.storageChatSets.length;
  await deleteReview(host.msty, "does-not-exist", "history-chat");
  assert.equal(host.calls.storageChatSets.length, setsBefore, "unknown-id delete must not rewrite storage");

  await clearReviews(host.msty, "history-chat");
  const afterClear = host.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`);
  assert.deepEqual(afterClear.entries, [], "clear empties the history document");
  assert.equal(afterClear.schemaVersion, HISTORY_SCHEMA_VERSION);
  console.log("[PASS][HT3] History delete / clear");
}

// HT3b — delete and clear are durable across fresh reads / re-activation.
// Store-level regression for the round-1 blocker, now without any legacy seed
// in play: once a delete/clear persists, no read path re-creates the entries.
{
  const host = createHost();
  const appended = await appendReview(host.msty, makeReview("Doomed to be deleted", 1), makeMeta(), "history-chat");
  assert.equal(appended.persisted, true, "append persists before delete");

  // Delete the only entry, then a fresh read / re-activation sees it gone.
  await deleteReview(host.msty, appended.entries[0].id, "history-chat");
  const afterDelete = await listReviews(host.msty, "history-chat");
  assert.deepEqual(afterDelete, [], "deleted entry stays deleted across a fresh read");
  await extension.activate(host.msty); // re-activation path (bootstrap reads are inside)
  const reactivatedAfterDelete = await listReviews(host.msty, "history-chat");
  assert.deepEqual(reactivatedAfterDelete, [], "delete is not resurrected by re-activation");

  // Append, store, then clear; a fresh read / re-activation stays empty.
  const appended2 = await appendReview(host.msty, makeReview("Then cleared"), makeMeta(), "history-chat");
  assert.equal(appended2.persisted, true);
  await clearReviews(host.msty, "history-chat");
  const afterClear = await listReviews(host.msty, "history-chat");
  assert.deepEqual(afterClear, [], "cleared history stays clear across a fresh read");
  await extension.activate(host.msty);
  const reactivatedAfterClear = await listReviews(host.msty, "history-chat");
  assert.deepEqual(reactivatedAfterClear, [], "clear is not resurrected by re-activation");
  console.log("[PASS][HT3b] Delete / clear are durable across fresh reads and re-activation");
}

// HT4 — send-one-to-composer (replace text via composer.setText, never send).
{
  const host = createHost();
  const { entries } = await appendReview(host.msty, makeReview("Composer review"), makeMeta(), "history-chat");
  await sendReviewToComposer(host.msty, entries[0]);
  assert.equal(host.calls.composerSet.length, 1, "one composer write");
  assert.match(host.calls.composerSet[0], /Revise your previous response using this independent review/);
  assert.match(host.calls.composerSet[0], /Issue 1/);
  assert.equal(host.calls.composerSet[0].includes("undefined"), false);
  console.log("[PASS][HT4] Send-one-to-composer");
}

// HT5 — legacy 1.2.x seed remains retired + fail-closed unknown chats
// (per-chat isolation, t_61dd1e7e). The 1.2.x `latest-review` payload carries
// no chat identifier (verified against the 1.2.5 baseline), so it cannot be
// attributed to any chat; with the composite per-chat key there is no place a
// seed could even land. The pane must show an EMPTY list in a fresh chat even
// with legacy data armed, storage.local must never be read for history, and
// an UNKNOWN chat id renders nothing (fail closed) without touching storage.
{
  const host = createHost({
    currentChat: { chat: { id: "fresh-chat" } },
    legacyReview: {
      review: makeReview(undefined, 1),
      meta: { messageCount: 4, modelLabel: "the main model fallback", completedAt: "2026-09-20T08:30:00.000Z" }
    }
  });
  const entries = await ensureHistory(host.msty, "fresh-chat");
  assert.deepEqual(entries, [], "a fresh chat must NOT receive the unattributable legacy review");

  // Fail closed: a null / unknown chat id lists nothing and writes nothing.
  assert.deepEqual(await listReviews(host.msty, null), [], "a null chat id renders nothing (fail closed)");
  assert.deepEqual(await listReviews(host.msty, "   "), [], "a blank chat id renders nothing (fail closed)");
  const storageReads = JSON.stringify(host.calls);
  assert.equal(host.chat.has(`${HISTORY_STORAGE_KEY}:fresh-chat`), false, "an empty-list fresh chat writes nothing");

  const runtime = await extension.activate(host.msty);
  await runtime.run(REVIEW_COMMAND);
  const listed = await listReviews(host.msty, "fresh-chat");
  assert.equal(listed.length, 1, "a fresh review persists normally under the new schema");
  assert.equal(listed[0].chatId, "fresh-chat", "the new entry is attributed to the chat it ran in");

  // storage.local is never consulted: no local.set, and the stored document
  // contains only the fresh review under the chat's composite key.
  assert.equal(host.chat.get(`${HISTORY_STORAGE_KEY}:fresh-chat`).entries.length, 1, "the chat document holds exactly the current chat's review");
  assert.equal(JSON.stringify(host.calls.storageLocalSets), "[]", "the extension never writes the legacy key");
  console.log("[PASS][HT5] Legacy 1.2.x seed retired + unknown chats fail closed");
}

// HT5b — per-chat isolation gates (t_61dd1e7e, composite-key semantics):
// (a) entry/doc attribution: chat A's review under chat A's key never renders
//     in chat B — chat B reads a different key AND entries carry the producing
//     chat id;
// (b) host-scope-bleed simulation: a foreign-attributed document parked at
//     chat B's key renders NOTHING in chat B, is never rewritten by a list,
//     and — the round-1 B3 fix — NEVER blocks chat B's own persistence: an
//     append in chat B still persists under chat B's key (replacing the stray
//     foreign-claimed base, never mixing chats);
// (c) mixed-attribution entries inside this chat's document are filtered from
//     the VIEW but never swept from storage — not by a list, and (round-1 B4
//     fix) not by an unknown-id delete;
// (d) null chat id renders nothing even against a real document (the inert-
//     guard hole of round 1 no longer exists).
{
  // (a) entry-level attribution across composite keys.
  const entryHost = createHost();
  await appendReview(entryHost.msty, makeReview("Foreign chat review"), makeMeta(), "chat-a");
  assert.ok(entryHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-a`), "chat A's document is under chat A's key");
  const fromChatB = await listReviews(entryHost.msty, "chat-b");
  assert.deepEqual(fromChatB.map((entry) => entry.title), [], "a review produced in chat A must not render in chat B");
  assert.equal(entryHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-a`).chatId, "chat-a", "the foreign document stays attributed to chat A");
  const fromChatA = await listReviews(entryHost.msty, "chat-a");
  assert.deepEqual(fromChatA.map((entry) => entry.title), ["Foreign chat review"], "the owning chat still sees its review");

  // (b) foreign document parked at this chat's key (host-scope bleed).
  const docHost = createHost();
  await appendReview(docHost.msty, makeReview("Chat A only"), makeMeta(), "chat-a");
  // Simulate the host handing chat B chat A's document: park it at chat B's key.
  docHost.chat.set(`${HISTORY_STORAGE_KEY}:chat-b`, JSON.parse(JSON.stringify(docHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-a`))));
  const bled = await listReviews(docHost.msty, "chat-b");
  assert.deepEqual(bled, [], "a foreign chat's document renders nothing in the current chat");
  const parkedBefore = JSON.stringify(docHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-b`));
  const appendedInB = await appendReview(docHost.msty, makeReview("Chat B review"), { ...makeMeta(), completedAt: "2026-09-22T11:00:00.000Z" }, "chat-b");
  assert.equal(appendedInB.persisted, true, "B3: a foreign document parked at this chat's key NEVER blocks persistence");
  assert.deepEqual(appendedInB.entries.map((entry) => entry.title), ["Chat B review"], "B3: the stray foreign base is not mixed into chat B's list");
  const afterB = docHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-b`);
  assert.equal(afterB.chatId, "chat-b", "B3: the persisted document carries THIS chat's id");
  assert.deepEqual(afterB.entries.map((entry) => entry.title), ["Chat B review"], "B3: chat B's review is persisted under chat B's key");
  const ownerDoc = docHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-a`);
  assert.deepEqual(ownerDoc.entries.map((entry) => entry.title), ["Chat A only"], "B3: chat A's real document is untouched by chat B's append");
  assert.equal(docHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-b`).entries.some((/** @type {any} */ entry) => entry.title === "Chat A only"), false, "B3: no foreign entry is persisted under chat B's key");

  // (c) mixed-attribution entries are filtered per entry, and an unknown-id
  // delete never sweeps them out of storage.
  const mixedHost = createHost();
  const mixed = await appendReview(mixedHost.msty, makeReview("Mine"), makeMeta(), "chat-c");
  const foreignEntry = JSON.parse(JSON.stringify(mixed.entries[0]));
  foreignEntry.id = "review-foreign";
  foreignEntry.title = "Not mine";
  foreignEntry.createdAt = "2026-09-21T12:00:00.000Z";
  foreignEntry.chatId = "chat-d";
  const document = mixedHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-c`);
  document.entries.push(foreignEntry);
  mixedHost.chat.set(`${HISTORY_STORAGE_KEY}:chat-c`, document);
  const listed = await listReviews(mixedHost.msty, "chat-c");
  assert.deepEqual(listed.map((entry) => entry.title), ["Mine"], "entries attributed to another chat never render, even mixed in this chat's document");
  assert.equal(mixedHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-c`).entries.length, 2, "the foreign entry is filtered from view, not deleted from storage");
  const setsBeforeDelete = mixedHost.calls.storageChatSets.length;
  await deleteReview(mixedHost.msty, "does-not-exist", "chat-c");
  assert.equal(mixedHost.calls.storageChatSets.length, setsBeforeDelete, "B4: unknown-id delete in a mixed document must not rewrite storage");
  assert.equal(mixedHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-c`).entries.length, 2, "B4: the foreign entry survives an unknown-id delete");

  // (d) null chat id renders nothing, even against a real document.
  const nullHost = createHost();
  await appendReview(nullHost.msty, makeReview("Chat B review"), makeMeta(), "chat-b");
  assert.deepEqual(await listReviews(nullHost.msty, null), [], "B2: a null chat id renders NOTHING (fail closed, no inert guards)");
  assert.ok(nullHost.chat.get(`${HISTORY_STORAGE_KEY}:chat-b`), "the fail-closed read never rewrote the document");
  console.log("[PASS][HT5b] Per-chat isolation: entry + document + composite-key guards");
}

// HT6 — quota rejection → prune oldest → retry once → still-failing path.
{
  // Two rejections: first append attempt fails, prune retry fails → not
  // persisted, but the in-memory list keeps the review (no silent loss).
  const failingHost = createHost({ chatRejectionSchedule: [1, 2] });
  const failing = await appendReview(failingHost.msty, makeReview("Doomed write"), makeMeta(), "history-chat");
  assert.equal(failing.persisted, false, "double rejection reports non-persistence");
  assert.equal(failing.entries[0].title, "Doomed write", "in-memory list keeps the review");
  assert.equal(failingHost.chat.has(`${HISTORY_STORAGE_KEY}:history-chat`), false, "nothing partially written");
  assert.equal(failingHost.calls.storageChatSets.length, 0, "retry happened but never succeeded");
  // Direct store calls never toast; reporting belongs to the runtime wiring
  // (verified below) so pane callers can choose their own surfacing.

  // One rejection then recovery: the prune retry persists the pruned list.
  const recoveringHost = createHost({ chatRejectionSchedule: [1] });
  const recovering = await appendReview(recoveringHost.msty, makeReview("Recovered write"), makeMeta(), "history-chat");
  assert.equal(recovering.persisted, true, "prune retry succeeds");
  const stored = recoveringHost.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`);
  assert.deepEqual(stored.entries.map((entry) => entry.title), ["Recovered write"], "pruned list contains the new entry");

  // Runtime wiring: a still-failing append surfaces exactly one toast and the
  // review still completes and persists the entry data for the pane.
  const wiredHost = createHost({ chatRejectionSchedule: [1, 2, 3, 4], surfaceUpdated: true });
  const wiredRuntime = await extension.activate(wiredHost.msty);
  await wiredRuntime.run(REVIEW_COMMAND);
  const historyWarnings = wiredHost.calls.notifications.filter((notification) => notification.title === "Review history not saved");
  assert.equal(historyWarnings.length, 1, "still-failing persistence reports one concise toast");
  assert.match(historyWarnings[0].body, /^diagnostic-stage=[a-z0-9-]+$/);
  // Card D: the drawer "Review complete" callout is gone; the reviewer-model
  // wording is observable in the in-memory history entry the pane renders,
  // and the run's success/failure channel is the notification stream.
  const completionToast = wiredHost.calls.notifications.at(-1);
  assert.equal(completionToast.tone, "success", "completion callout wording unchanged despite history failure");
  console.log("[PASS][HT6] Quota rejection prune / retry / no silent loss");
}

// HT7 — toast policy: durationMs everywhere, singles, failure body stage token.
{
  const failureHost = createHost({ currentChat: {} });
  const runtime = await extension.activate(failureHost.msty);
  await runtime.run(REVIEW_COMMAND);
  assert.equal(failureHost.calls.notifications.length > 0, true, "failure flow emits toasts");
  for (const notification of failureHost.calls.notifications) {
    assertNotification(notification, "toast policy");
  }
  const errorToast = failureHost.calls.notifications.find((notification) => notification.tone === "error");
  assert.equal(errorToast.title, "Review failed");
  // Card D: the failure toast body is exactly the bare stage token (shared
  // wording across the runtime; the pane adds human context when open).
  assert.match(
    errorToast.body,
    /^diagnostic-stage=[a-z0-9-]+$/,
    "failure toast body is exactly the bare stage token (no extra clauses)"
  );
  assert.equal(errorToast.durationMs > 0, true, "failure toast durationMs explicit");

  const successHost = createHost();
  const successRuntime = await extension.activate(successHost.msty);
  await successRuntime.run(REVIEW_COMMAND);
  for (const notification of successHost.calls.notifications) {
    assertNotification(notification, "success toast policy");
    if (notification.tone === "success") {
      assert.equal(
        notification.body === undefined || notification.body === "",
        true,
        "confirmation toasts are title-only (no body)"
      );
    }
  }
  const confirmationToasts = successHost.calls.notifications.filter((notification) => notification.tone === "success");
  assert.equal(confirmationToasts.length >= 1, true);

  // reportPersistenceFailure always uses the bare token and warning tone.
  const reportingHost = createHost({ chatRejectionSchedule: [1, 2] });
  await reportPersistenceFailure(reportingHost.msty);
  const warning = reportingHost.calls.notifications[0];
  assert.equal(warning.tone, "warning");
  assert.match(warning.body, /^diagnostic-stage=[a-z0-9-]+$/);
  console.log("[PASS][HT7] Toast policy");
}

// HT8 — regression: completion result data + structured issue persistence.
// Card D: the drawer callout stream is retired; the same wording data now
// surfaces through the persisted history entry (messageCount / modelLabel /
// structured issues) that the pane renders.
{
  const host = createHost({ inferJson: makeReview("Regression check", 2) });
  const runtime = await extension.activate(host.msty);
  await runtime.run(REVIEW_COMMAND);

  const stored = JSON.parse(JSON.stringify(host.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`)));
  assert.ok(stored, "runtime wiring persists under the chat's composite key");
  assert.equal(stored.chatId, "history-chat", "runtime wiring stores the active chat id with the entry");
  const entry = stored.entries[0];
  assert.equal(entry.title, "Regression check", "completed review is persisted to chat history");
  assert.equal(entry.messageCount, 2, "recent-message count is preserved for the pane row meta");
  assert.equal(entry.modelLabel, "your reviewer model", "reviewer-model wording preserved");
  assert.match(entry.summary, /^2 issues found\.$/);
  assert.equal(entry.issues.length, 2, "structured issues persisted unchanged");
  assert.equal(entry.issues[0].severity, "High");
  assert.equal(JSON.stringify(entry).includes("**"), false, "no raw markdown in stored review data");

  const successToast = host.calls.notifications.at(-1);
  assert.equal(successToast.tone, "success", "completion still reports success");
  console.log("[PASS][HT8] Completion result data + structured issue persistence regression");
}

// HT9 — executeReview shared core: normalized success/failure contract.
{
  const host = createHost({ inferJson: makeReview("Core review") });
  const result = await executeReview(host.msty, "focus on citations");
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ["chatId", "meta", "ok", "review"]);
  assert.equal(typeof result.chatId, "string");
  assert.equal(result.review.title, "Core review");
  assert.deepEqual(Object.keys(result.meta).sort(), ["completedAt", "messageCount", "modelLabel"]);
  assert.deepEqual(Object.keys(result.review).sort(), ["issues", "summary", "title"]);
  assert.deepEqual(Object.keys(host.calls.infer[0]).includes("modelAssignment"), true, "assigned reviewer enables modelAssignment");
  assert.equal(host.calls.infer[0].responseFormat.schema.required.includes("title"), true);

  const failingHost = createHost({ currentChat: {} });
  const failure = await executeReview(failingHost.msty);
  // t_fa7ab623: the failure result is no longer the bare stage — it carries the
  // preserved cause and a bounded, single-line reason beside the token.
  assert.equal(failure.ok, false);
  assert.equal(failure.stage, "current-chat-lookup");
  assert.equal(failure.detail, "Error: No active chat");
  assert.equal(failure.cause instanceof Error, true, "the thrown value must be preserved as the cause");
  assert.equal(failure.cause.message, "No active chat");
  assert.equal(failure.detail.length <= FAILURE_DETAIL_MAX_LENGTH, true);
  console.log("[PASS][HT9] Shared core normalized result contract");
}

// HT10 — saving the pane's edit on ONE entry (t_db84b23e). The field is
// ADDITIVE (a document written before this feature existed keeps normalising),
// the edit lands on that entry alone in THAT chat's document, the review's own
// summary/issues/title are untouched (editing text is not re-deriving issues),
// a blank draft is not an edit, and "Send to composer" then places the framing
// sentence plus the EDITED body in the composer.
{
  const host = createHost();
  // An OLDER document: no `editedBody` key anywhere.
  host.chat.set(`${HISTORY_STORAGE_KEY}:history-chat`, {
    schemaVersion: 1,
    chatId: "history-chat",
    entries: [
      {
        id: "legacy-1",
        title: "Old review",
        createdAt: "2026-09-20T10:00:00.000Z",
        messageCount: 2,
        modelLabel: "m",
        summary: "One issue found.",
        chatId: "history-chat",
        issues: [{ severity: "High", title: "Issue 1", location: "Message 1", problem: "P", correction: "C" }]
      }
    ]
  });
  const before = await listReviews(host.msty, "history-chat");
  assert.equal(before.length, 1, "a document written by an older version still normalises");
  assert.equal(before[0].editedBody, null, "an entry the old version wrote normalises to editedBody: null (additive, never undefined)");
  assert.equal(before[0].summary, "One issue found.", "the older document's other fields survive normalisation");

  // A second chat: the edit must never reach it.
  await appendReview(host.msty, makeReview("Other chat review"), makeMeta(), "other-chat");
  const otherWritesBefore = host.calls.storageChatSets.filter((call) => call.key === `${HISTORY_STORAGE_KEY}:other-chat`).length;
  assert.equal(otherWritesBefore, 1, "precondition: the other chat has exactly its own append write");

  const edited = "My own words.\n\n1. First point.\n2. Second point.";
  const saved = await updateReviewBody(host.msty, "legacy-1", edited, "history-chat");
  assert.equal(saved.persisted, true, "the edit persists");
  assert.equal(saved.entries.length, 1, "the returned list is the chat's own visible entries");
  assert.equal(saved.entries[0].editedBody, edited, "the returned entry carries the edited body");

  const stored = host.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`);
  assert.equal(stored.entries.length, 1, "the edit does not add or drop entries");
  assert.equal(stored.entries[0].editedBody, edited, "the edited body is stored VERBATIM (line breaks included)");
  assert.equal(stored.entries[0].summary, "One issue found.", "the review's own summary is untouched");
  assert.equal(stored.entries[0].issues.length, 1, "the review's own issues are untouched — editing is not re-deriving");
  assert.equal(stored.entries[0].title, "Old review", "the title (the header's original count/severity data) is untouched");
  assert.equal(stored.entries[0].id, "legacy-1", "the same entry was updated, not replaced");
  assert.equal(
    host.calls.storageChatSets.filter((call) => call.key === `${HISTORY_STORAGE_KEY}:other-chat`).length,
    otherWritesBefore,
    "no other chat's document is written by the edit"
  );

  // A fresh read returns it, and the composer text is framing + the EDITED body.
  const after = await listReviews(host.msty, "history-chat");
  assert.equal(after[0].editedBody, edited, "a fresh read returns the edited body");
  await sendReviewToComposer(host.msty, after[0]);
  assert.equal(
    host.calls.composerSet.at(-1),
    `${REVISION_FRAMING}\n\n${edited}`,
    "\"Send to composer\" sends the framing sentence plus the EDITED body, verbatim"
  );

  // A BLANK draft is not an edit: nothing is written, nothing is lost.
  const writesBeforeBlank = host.calls.storageChatSets.length;
  const blank = await updateReviewBody(host.msty, "legacy-1", "   \n  ", "history-chat");
  assert.equal(blank.persisted, true, "a blank draft reports success — there was nothing to store");
  assert.equal(host.calls.storageChatSets.length, writesBeforeBlank, "a blank draft writes nothing");
  assert.equal(host.chat.get(`${HISTORY_STORAGE_KEY}:history-chat`).entries[0].editedBody, edited, "a blank draft leaves the stored edit alone");

  // Fail closed: an unknown chat id and an unknown entry id are no-ops.
  assert.deepEqual(
    await updateReviewBody(host.msty, "legacy-1", "nope", null),
    { entries: [], persisted: false },
    "an unresolvable chat id writes nothing (fail closed)"
  );
  const unknownId = await updateReviewBody(host.msty, "not-in-this-chat", "nope", "history-chat");
  assert.deepEqual(unknownId.entries.map((entry) => entry.id), ["legacy-1"], "an unknown entry id writes nothing and returns the visible entries");
  assert.equal(host.calls.storageChatSets.length, writesBeforeBlank, "the no-op paths wrote nothing at all");

  // An UNEDITED entry still sends the derived body — the pre-edit behaviour.
  await appendReview(host.msty, makeReview("Never edited"), makeMeta(), "history-chat");
  const unedited = (await listReviews(host.msty, "history-chat")).find((entry) => entry.title === "Never edited");
  await sendReviewToComposer(host.msty, unedited);
  const derived = host.calls.composerSet.at(-1);
  assert.equal(derived.startsWith(`${REVISION_FRAMING}\n\nIndependent review summary:`), true, "an unedited review still sends framing + the derived body");
  assert.equal(derived.includes(edited), false, "the edited body of another entry never leaks into an unedited one");
  console.log("[PASS][HT10] The edited review body: additive field, one chat, one entry, framing + edited body on send");
}

console.log("Hermes Review history contract checks passed (10 scenarios).");