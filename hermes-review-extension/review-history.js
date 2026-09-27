// @ts-check
// Per-chat review history store backed by `storage.chat`.
//
// Per-chat isolation (t_61dd1e7e) rests on a SCOPING-INDEPENDENT scheme, not
// on an assumption about how the host scopes `storage.chat` reads:
//
// 1. Composite keys. The history document lives under
//    `review-history:<chatId>`, a distinct `storage.chat` key per chat. No
//    write path can ever be blocked by a document it cannot attribute (a
//    single-key design silently stopped persisting in every chat that was
//    handed a foreign document), and a host that mis-delivers another chat's
//    document cannot make chat A's reviews render in chat B: chat B reads a
//    different key. The active chat id comes from `getCurrentChat`, the one
//    attribution source the host really supplies in BOTH the runtime and
//    custom-UI frames (d.ts:1220; SurfaceApi only omits registration APIs,
//    d.ts:1319).
// 2. Fail closed. With no resolvable chat id nothing is read, rendered,
//    written, deleted, or cleared — an unknown chat can never render unknown
//    data, and a review that cannot be attributed stays in memory for the
//    session and is reported as not persisted, never planted under a guessed
//    key.
// 3. Defense-in-depth attribution. Entries carry the `chatId` they were
//    produced in (from the review outcome, never a foreign document's claim)
//    and the document carries its owner id; a document that demonstrably
//    belongs to another chat is not rendered and never rewritten.
//
// There is deliberately NO migration: the 1.2.x `latest-review` payload
// carried no chat identifier (verified against the 1.2.5 baseline), so seeding
// it was the observed cross-chat leak; it is never read (stale keys stay on
// disk, unread). Documents from the interim single `review-history` key
// (pre-per-chat build) are likewise left unread at their old key.
//
// Only normalized reviews are stored — never the raw transcript. There is no
// artificial entry cap; quota pressure is handled by pruning oldest entries
// and retrying once. Usable from the extension runtime and sandboxed custom UI
// frames alike: it only touches storage, notifications, composer, and the
// shared review core.

import {
  sendReviewToComposer as coreSendReviewToComposer,
  showToast
} from "./review-core.js";

/**
 * Key PREFIX inside the `storage.chat` scope. The full key for one chat is
 * `review-history:<chatId>` (see historyStorageKey) — one document per chat.
 */
export const HISTORY_STORAGE_KEY = "review-history";
/** History document schema marker (stable since 1.3.0; no migration path). */
export const HISTORY_SCHEMA_VERSION = 1;
/** Stage tag for a rejected history write that survived the prune retry. */
export const HISTORY_PERSISTENCE_STAGE = "history-persistence";

/**
 * The per-chat storage key for one chat's history document.
 * @param {string} chatId
 */
export function historyStorageKey(chatId) {
  return `${HISTORY_STORAGE_KEY}:${chatId}`;
}

/** @param {unknown} value @returns {any} */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** @param {unknown} value */
function asNonBlankString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Normalizes one stored entry into the persisted shape. Returns null for
 * values that cannot be represented at all.
 * @param {unknown} value
 */
function normalizeEntry(value) {
  const record = asObject(value);
  if (!record) return null;
  const issues = Array.isArray(record.issues) ? record.issues : [];
  return {
    id: asNonBlankString(record.id) ?? `review-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    title: asNonBlankString(record.title) ?? "Review",
    createdAt: asNonBlankString(record.createdAt) ?? new Date(0).toISOString(),
    messageCount: typeof record.messageCount === "number" && Number.isFinite(record.messageCount) ? record.messageCount : 0,
    modelLabel: asNonBlankString(record.modelLabel) ?? "the selected model",
    summary: asNonBlankString(record.summary) ?? "",
    // The user's EDITED review body, when they have edited this review in the
    // pane (t_db84b23e). Additive: a document written by any earlier version
    // simply has no such field and normalizes to null, and an entry with no
    // edit carries null — never "" (blank is not an edit). It overrides the
    // derived body for display and for "Send to composer"; the review's own
    // summary/issues stay untouched.
    editedBody: asNonBlankString(record.editedBody),
    // The chat the review was produced in. Entries that cannot show one carry
    // null and are rendered only when the document itself is not
    // chat-attributed (see filterChatEntries).
    chatId: asNonBlankString(record.chatId),
    issues: issues.map((/** @type {any} */ issue) => {
      const issueRecord = asObject(issue) ?? {};
      const rawSeverity = asNonBlankString(issueRecord.severity) ?? "Medium";
      return {
        severity: rawSeverity === "High" || rawSeverity === "Low" ? rawSeverity : "Medium",
        title: asNonBlankString(issueRecord.title) ?? "Review issue",
        location: asNonBlankString(issueRecord.location) ?? "Location not specified",
        problem: asNonBlankString(issueRecord.problem) ?? "No explanation supplied.",
        correction: asNonBlankString(issueRecord.correction) ?? "No correction supplied."
      };
    })
  };
}

/** @param {any} entry */
function entryVersionKey(entry) {
  const time = Date.parse(entry.createdAt);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * True when the stored history document demonstrably belongs to a DIFFERENT
 * chat than the one now active. Defense-in-depth around the composite key: a
 * host that mis-delivers another chat's document cannot get it rendered or
 * rewritten.
 * @param {{chatId: string|null}} document @param {string|null} currentChatId
 */
function isForeignDocument(document, currentChatId) {
  return Boolean(currentChatId && document.chatId && document.chatId !== currentChatId);
}

/**
 * Drops entries attributed to another chat. Entry-level defense for
 * mixed-attribution documents. Unknown-attribution entries (null chatId) are
 * kept when the document is not foreign.
 * @param {any[]} entries @param {{chatId: string|null}} document @param {string|null} currentChatId
 */
function filterChatEntries(entries, document, currentChatId) {
  if (isForeignDocument(document, currentChatId)) return [];
  if (!currentChatId) return entries;
  return entries.filter((/** @type {any} */ entry) => !entry.chatId || entry.chatId === currentChatId);
}

/**
 * Writes ONE chat's history document under its composite key.
 * @param {any} msty @param {string} chatId @param {any} value
 */
async function writeHistoryDocument(msty, chatId, value) {
  const history = msty?.storage?.chat;
  if (!history) throw new Error("storage.chat unavailable");
  await history.set(historyStorageKey(chatId), value);
}

/**
 * Reads ONE chat's history document under its composite key. Returns null for
 * unknown chat ids (fail closed) and for a missing document. Whatever is
 * stored is returned as read; the caller owns filtering and attribution.
 * @param {any} msty @param {string|null} chatId
 * @returns {Promise<{chatId: string|null, entries: any[]}|null>}
 */
async function readHistoryDocument(msty, chatId) {
  const history = msty?.storage?.chat;
  const resolvedChatId = asNonBlankString(chatId);
  if (!history || !resolvedChatId) return null;
  const raw = asObject(await history.get(historyStorageKey(resolvedChatId)));
  if (!raw) return null;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((/** @type {any} */ entry) => normalizeEntry(entry)).filter(Boolean)
    : [];
  return { chatId: asNonBlankString(raw.chatId), entries };
}

/**
 * Lists the CURRENT CHAT's stored reviews, newest first, from the chat's own
 * composite key, claiming (attributing) an unattributed document in place.
 * Unknown chat ids render nothing. A document that demonstrably belongs to
 * another chat is never returned and never rewritten.
 * @param {any} msty @param {string|null} [activeChatId] active chat id from the host context
 * @returns {Promise<any[]>} current chat's entries, newest first
 */
export async function ensureHistory(msty, activeChatId) {
  const currentChatId = asNonBlankString(activeChatId);
  if (!currentChatId) return [];
  const stored = await readHistoryDocument(msty, currentChatId);
  if (!stored || isForeignDocument(stored, currentChatId)) return [];
  // Claim an unattributed document for the active chat (pre-attribution data
  // found under this chat's own key). A foreign document is never rewritten.
  if (!stored.chatId) {
    try {
      await writeHistoryDocument(msty, currentChatId, {
        schemaVersion: HISTORY_SCHEMA_VERSION,
        chatId: currentChatId,
        entries: stored.entries
      });
    } catch {
      // The in-memory list keeps the entries usable for this session.
    }
  }
  return filterChatEntries(stored.entries, stored, currentChatId);
}

/**
 * Appends a completed review as the newest entry of the CHAT'S OWN document
 * and persists it under the chat's composite key. On quota-style write
 * rejection the oldest entries are pruned and the write is retried once; if
 * it still fails, the in-memory list keeps the review and the caller reports
 * it through the returned flag — never a silent loss. When the host does not
 * expose `storage.chat` at all, the write is skipped with `unavailable: true`
 * (capability absent is not a rejected write).
 *
 * @param {any} msty @param {any} review @param {any} meta @param {string} [chatId] active chat id from the review outcome
 * @returns {Promise<{entries: any[], persisted: boolean, unavailable?: boolean}>}
 */
export async function appendReview(msty, review, meta, chatId) {
  const history = msty?.storage?.chat;
  if (!history) return { entries: [], persisted: false, unavailable: true };
  return appendReviewEntry(msty, {
    id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    review: typeof review?.title === "string" ? review : { ...review, title: "Review" },
    completedAt: meta?.completedAt ?? new Date().toISOString(),
    messageCount: meta?.messageCount,
    modelLabel: meta?.modelLabel,
    chatId
  });
}

/**
 * Normalizes the prepared entry against the chat's own document, then prunes
 * + retries once on a rejected write. The new entry is ALWAYS attributed to
 * the chat it was produced in (the review outcome's chat id) and is ONLY ever
 * written under that chat's composite key — no host mis-delivery can make it
 * land in another chat's document. An unattributable review stays in memory
 * for the session and is reported as not persisted.
 * @param {any} msty
 * @param {{id: string, review: any, completedAt: string, messageCount: any, modelLabel: any, chatId: (string|null|undefined)}} draft
 */
async function appendReviewEntry(msty, draft) {
  const entry = normalizeEntry({
    id: draft.id,
    title: draft.review.title,
    createdAt: draft.completedAt,
    messageCount: draft.messageCount,
    modelLabel: draft.modelLabel,
    summary: draft.review.summary,
    issues: Array.isArray(draft.review.issues) ? draft.review.issues : [],
    chatId: draft.chatId
  });
  if (!entry) throw new Error("Review could not be normalized for storage");

  const currentChatId = asNonBlankString(draft.chatId);
  if (!currentChatId) {
    // No attribution, no key: keep the review for this session and let the
    // caller report the non-persistence (never a silenced guess).
    return { entries: [entry], persisted: false };
  }

  const current = await readHistoryDocument(msty, currentChatId);
  // Whatever sits under THIS chat's key, the new review is always written
  // back here with THIS chat's id: persistence can never be blocked by a
  // document this call cannot attribute (B3, t_61dd1e7e — the composite-key
  // scheme's whole point). The chat's own document lives at its own key, so a
  // foreign-ATTRIBUTED document parked at this key is stray data, not the
  // other chat's history: the append starts from the chat's visible entries
  // (or a clean base when the parked document claims another chat) instead of
  // mixing chats.
  const foreign = Boolean(current && isForeignDocument(current, currentChatId));
  const baseEntries = current && !foreign
    ? filterChatEntries(current.entries, current, currentChatId)
    : [];
  const entries = [entry, ...baseEntries];

  const documentToPersist = { schemaVersion: HISTORY_SCHEMA_VERSION, chatId: currentChatId, entries };
  try {
    await writeHistoryDocument(msty, currentChatId, documentToPersist);
    return { entries: filterChatEntries(entries, { chatId: currentChatId }, currentChatId), persisted: true };
  } catch {
    // First rejection: prune oldest entries (keep the newest half, at least
    // the new entry) and retry exactly once.
    const keep = Math.max(1, Math.ceil(entries.length / 2));
    const pruned = entries.slice(0, keep);
    try {
      await writeHistoryDocument(msty, currentChatId, { ...documentToPersist, entries: pruned });
      return { entries: pruned, persisted: true };
    } catch {
      return { entries, persisted: false };
    }
  }
}

/**
 * Lists the CURRENT CHAT's stored reviews, newest first. Unknown chat ids
 * render nothing (fail closed); foreign entries are filtered at the view
 * layer and left untouched in storage.
 * @param {any} msty @param {string|null} [activeChatId] active chat id from the host context
 * @returns {Promise<any[]>} entries, newest first
 */
export async function listReviews(msty, activeChatId) {
  return ensureHistory(msty, activeChatId);
}

/**
 * Deletes one entry by id from the CURRENT CHAT's document (no-op when the id
 * is unknown) and persists. The no-op decision compares against the
 * UNFILTERED document, so a delete can never sweep foreign-attributed entries
 * out of storage as a side effect: view filtering is display-only.
 * @param {any} msty @param {string} id @param {string|null} [activeChatId] active chat id from the host context
 */
export async function deleteReview(msty, id, activeChatId) {
  const currentChatId = asNonBlankString(activeChatId);
  if (!currentChatId) return [];
  const current = await readHistoryDocument(msty, currentChatId);
  if (!current || isForeignDocument(current, currentChatId)) return [];
  const visible = filterChatEntries(current.entries, current, currentChatId);
  // No-op guard against the UNFILTERED document: this id was never in this
  // chat's document, so nothing changes — and critically the filtered VIEW is
  // never persisted back (that would erase foreign entries from storage).
  if (!current.entries.some((/** @type {any} */ entry) => entry.id === id)) return visible;
  const entries = current.entries.filter((/** @type {any} */ entry) => entry.id !== id);
  await writeHistoryDocument(msty, currentChatId, { schemaVersion: HISTORY_SCHEMA_VERSION, chatId: currentChatId, entries });
  return filterChatEntries(entries, { chatId: currentChatId }, currentChatId);
}

/**
 * Stores the user's EDITED body on ONE entry of the CURRENT CHAT's document
 * (t_db84b23e). Every other field of the entry is kept exactly as stored — in
 * particular the review's own summary, issues, title and counts: editing the
 * text is not re-deriving issues, and the pane's "edited" marker is what
 * explains the difference.
 *
 * Same guard rails as delete: an unknown chat id, a foreign-attributed
 * document, or an id that is not in this chat's document are no-ops that write
 * nothing (fail closed, never a guessed key); the no-op decision compares
 * against the UNFILTERED document so a foreign-attributed sibling is never
 * rewritten either. A blank body is NOT an edit and saves nothing — the entry
 * keeps what it had, and the caller still returns to the read-only row.
 *
 * @param {any} msty @param {string} id @param {unknown} body the edited body text
 * @param {string|null} [activeChatId] active chat id from the host context
 * @returns {Promise<{entries: any[], persisted: boolean, unavailable?: boolean}>}
 */
export async function updateReviewBody(msty, id, body, activeChatId) {
  const history = msty?.storage?.chat;
  if (!history) return { entries: [], persisted: false, unavailable: true };
  const currentChatId = asNonBlankString(activeChatId);
  if (!currentChatId) return { entries: [], persisted: false };
  const current = await readHistoryDocument(msty, currentChatId);
  if (!current || isForeignDocument(current, currentChatId)) return { entries: [], persisted: false };
  const visible = filterChatEntries(current.entries, current, currentChatId);
  const edited = asNonBlankString(body);
  // Nothing to store: a blank draft, or an id this chat's document does not
  // hold. Reported as persisted because no write was needed and none failed.
  if (!edited || !current.entries.some((/** @type {any} */ entry) => entry.id === id)) {
    return { entries: visible, persisted: true };
  }
  const entries = current.entries.map((/** @type {any} */ entry) =>
    entry.id === id ? { ...entry, editedBody: edited } : entry
  );
  try {
    await writeHistoryDocument(msty, currentChatId, { schemaVersion: HISTORY_SCHEMA_VERSION, chatId: currentChatId, entries });
    return { entries: filterChatEntries(entries, { chatId: currentChatId }, currentChatId), persisted: true };
  } catch {
    // No pruning retry: the edit does not grow the document, so a rejected
    // write is a rejected write. The caller reports it; storage keeps the
    // previous body.
    return { entries: visible, persisted: false };
  }
}

/**
 * Clears every entry for the active chat and persists. A foreign chat's
 * document is never rewritten: the caller only ever clears the current chat.
 * @param {any} msty @param {string|null} [activeChatId] active chat id from the host context
 */
export async function clearReviews(msty, activeChatId) {
  const currentChatId = asNonBlankString(activeChatId);
  if (!currentChatId) return [];
  // Whatever a host mis-delivery parked at this chat's key, the clear always
  // writes THIS chat's empty document back (persistence never blocked).
  await writeHistoryDocument(msty, currentChatId, { schemaVersion: HISTORY_SCHEMA_VERSION, chatId: currentChatId, entries: [] });
  return [];
}

/**
 * Reads the CURRENT CHAT's entries, newest first (activation bootstrap).
 * Unknown chat ids and foreign-chat documents return an empty list; the
 * foreign document is left untouched.
 * @param {any} msty @param {string|null} [activeChatId] active chat id from the host context
 * @returns {Promise<any[]>} entries, newest first
 */
export async function readReviewsNewestFirst(msty, activeChatId) {
  const currentChatId = asNonBlankString(activeChatId);
  if (!currentChatId) return [];
  const current = await readHistoryDocument(msty, currentChatId);
  if (!current || isForeignDocument(current, currentChatId)) return [];
  return [...filterChatEntries(current.entries, current, currentChatId)].sort((/** @type {any} */ a, /** @type {any} */ b) => entryVersionKey(b) - entryVersionKey(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Places the revision prompt for one stored review in the composer via
 * `composer.setText` and confirms with the concise composer toast. Never
 * auto-sends.
 *
 * Sends the framing sentence plus the row's body — the STORED edited body when
 * the review has been edited in the pane, the derived body when it has not
 * (t_db84b23e). The normalization that decides what "the review" is lives in
 * `review-core.js` (`revisionReview`), so the text the pane shows in its edit
 * field and the text this function places in the composer cannot drift apart.
 * @param {any} msty @param {any} entryOrReview
 */
export async function sendReviewToComposer(msty, entryOrReview) {
  const record = asObject(entryOrReview) ?? {};
  await coreSendReviewToComposer(msty, record, asNonBlankString(record.editedBody));
}

/**
 * Reports a failed history persistence with one concise toast whose body is
 * the bare diagnostic stage token.
 * @param {any} msty
 */
export async function reportPersistenceFailure(msty) {
  try {
    await showToast(msty, {
      title: "Review history not saved",
      body: `diagnostic-stage=${HISTORY_PERSISTENCE_STAGE}`,
      tone: "warning",
      durationMs: 6000
    });
  } catch {
    // The in-memory list already preserves the review for this session.
  }
}
