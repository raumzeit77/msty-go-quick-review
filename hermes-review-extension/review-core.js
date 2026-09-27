// @ts-check
// Shared independent-review workflow core.
//
// Runs from both the extension runtime (ExtensionApi) and custom UI frames
// (SurfaceApi): it only uses context, messages, models, composer, storage,
// notifications, and non-registration UI/channel-agnostic helpers. It never
// registers commands or workspace items and never opens or patches surfaces —
// presentation stays with the caller. Card D calls these same functions.

/** Number of recent messages the reviewer examines. */
export const MAX_MESSAGES = 10;
/** Reviewer modelAssignment ID contributed by the manifest. */
export const REVIEWER_ASSIGNMENT_ID = "reviewer";
/** Fallback diagnostic stage when an error carries no stage. */
export const DIAGNOSTIC_FALLBACK_STAGE = "review-workflow";
/**
 * Upper bound on the preserved failure detail (t_fa7ab623). The stage token
 * stays the designed surface; the detail rides beside it as one bounded line,
 * so a host-only failure is diagnosable without a code change.
 */
export const FAILURE_DETAIL_MAX_LENGTH = 160;
/** Replacement for text a detail must never carry (credentials, run content). */
export const FAILURE_DETAIL_REDACTED = "[redacted]";

export const REVIEW_SYSTEM_PROMPT = `You are a strict independent reviewer. Examine only the supplied chat transcript.

Return a JSON object matching the requested schema. Report only concrete problems. Each issue must contain:
- severity: High, Medium, or Low
- title: short statement of the problem
- location: message number and relevant passage or claim
- problem: why it is wrong, unsupported, risky, misleading, or incomplete
- correction: a specific way to fix it

Also return a short title (at most 60 characters) that names what the review covers.

Prioritize factual errors, unsupported claims, stale or unverifiable reporting, citation problems, contradictions, instruction failures, safety issues, and important omissions. Do not praise the response. If there are no material issues, return an empty issues array and a concise summary saying so. Do not claim that you verified online information: this reviewer currently has no tool access.`;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "issues", "title"],
  properties: {
    title: { type: "string", maxLength: 60 },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "location", "problem", "correction"],
        properties: {
          severity: { type: "string", enum: ["High", "Medium", "Low"] },
          title: { type: "string" },
          location: { type: "string" },
          problem: { type: "string" },
          correction: { type: "string" }
        }
      }
    }
  }
};

/** Maximum length of an auto-generated review title. */
export const TITLE_MAX_LENGTH = 60;

/**
 * What a shortened string ends with (t_07094a37): a SPACE, then the ellipsis —
 * never an ellipsis glued to the last word. One constant, so the title clamp
 * and the failure-detail bound cannot spell the convention two ways, and the
 * copy gate can assert the marker itself instead of scanning for `...`.
 */
export const TRUNCATION_MARKER = " …";

/** @param {string} value */
function isBlank(value) {
  return value.trim().length === 0;
}

/** @param {unknown} value */
export function asNonBlankString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value @returns {any} */
export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** @param {unknown[]} values */
export function firstNonBlankString(...values) {
  for (const value of values) {
    const normalized = asNonBlankString(value);
    if (normalized) return normalized;
  }
  return null;
}

/** @param {unknown} value */
export function getConversationId(value) {
  const record = asObject(value);
  if (!record) return null;

  const nestedChat = asObject(record.chat);
  return firstNonBlankString(
    nestedChat?.id,
    nestedChat?.chatId,
    nestedChat?.conversationId,
    record.chatId,
    record.conversationId,
    record.activeChatId,
    record.activeConversationId,
    record.id
  );
}

/** @param {string} stage */
export function stageFailureMessage(stage) {
  return `Review failed. diagnostic-stage=${stage}`;
}

export function diagnosticMessage(/** @type {unknown} */ error) {
  const stage = error instanceof ReviewStageError ? error.stage : DIAGNOSTIC_FALLBACK_STAGE;
  return stageFailureMessage(stage);
}

export class ReviewStageError extends Error {
  /**
   * @param {string} stage
   * @param {unknown} [cause] the thrown value, preserved verbatim as `cause`
   * @param {{detail?: unknown, redact?: string[]}} [options] `detail` rehydrates
   *        an already-sanitized line (the runtime rebuilds this error from
   *        executeReview's failure result, which carries no live cause chain)
   */
  constructor(stage, cause = null, options = {}) {
    super(`diagnostic-stage=${stage}`);
    this.name = "ReviewStageError";
    this.stage = stage;
    // The REASON the stage failed, bounded to one credential-free line. Before
    // t_fa7ab623 this was discarded, which made a host-only failure
    // undebuggable inside the process.
    this.detail = boundFailureDetail(options.detail, []) ?? describeFailure(cause, { redact: options.redact });
    this.cause = cause ?? null;
  }
}

/**
 * Credential-shaped strings stripped from a preserved failure detail. Pattern
 * matching cannot be exhaustive — it removes the shapes an inference/provider
 * error realistically quotes (bearer tokens, `sk-` keys, JWTs, `api_key=`).
 */
const FAILURE_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi
];

/**
 * Bounds arbitrary detail text to one line of at most
 * FAILURE_DETAIL_MAX_LENGTH characters. Run-content fragments named in
 * `redact` (the transcript and the user's instruction) and credential-shaped
 * strings are replaced before the text is collapsed and truncated. Returns
 * null for anything that is not a non-blank string.
 *
 * @param {unknown} value @param {string[]} [redact]
 */
export function boundFailureDetail(value, redact = []) {
  if (typeof value !== "string") return null;
  let text = value;
  for (const fragment of Array.isArray(redact) ? redact : []) {
    if (typeof fragment !== "string" || fragment.trim().length < 8) continue;
    text = text.split(fragment).join(FAILURE_DETAIL_REDACTED);
  }
  for (const pattern of FAILURE_SECRET_PATTERNS) text = text.replace(pattern, FAILURE_DETAIL_REDACTED);
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return null;
  return singleLine.length > FAILURE_DETAIL_MAX_LENGTH
    ? `${singleLine.slice(0, FAILURE_DETAIL_MAX_LENGTH - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`
    : singleLine;
}

/**
 * Reads one field off an arbitrary thrown value without trusting it: a hostile
 * object can throw from a getter, so a failed read is simply "absent".
 * @param {unknown} value @param {string} key
 */
function readFailureField(value, key) {
  try {
    const record = asObject(value);
    return record ? record[key] : undefined;
  } catch {
    return undefined;
  }
}

/** A short identifier-ish token (error name / code / status), or null.
 * @param {unknown} value @param {number} [maxLength] */
function asSafeIdentifierToken(value, maxLength = 48) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return /^[A-Za-z0-9_.\- ]+$/.test(trimmed) ? trimmed : null;
}

/** First safe identifier token among the candidates, or null.
 * @param {unknown[]} values */
function firstSafeIdentifierToken(...values) {
  for (const value of values) {
    const token = asSafeIdentifierToken(value);
    if (token) return token;
  }
  return null;
}

/**
 * Bounded literal returned when a thrown value defeats classification entirely
 * (an exotic proxy, a throwing `getPrototypeOf`/`getOwnPropertyDescriptor`
 * trap). Never thrown: a reason that cannot be derived must still not become a
 * second, invisible failure.
 */
const FAILURE_CLASSIFICATION_FALLBACK = "Error: failure reason unavailable";

/**
 * Classifies one thrown value into a bounded, credential-free reason line: the
 * error's own name and message (bounded/redacted) plus a code/status when the
 * value carries one. The thrown value is never serialized — nested objects,
 * arrays, getters and `toJSON` are never read — so a hostile or opaque throw
 * yields a stable classification instead of a disclosure.
 *
 * Never throws, and never returns an empty string (B0): every read of the
 * thrown value goes through `readFailureField`, and anything that still defeats
 * the classifier degrades to FAILURE_CLASSIFICATION_FALLBACK instead of
 * escaping the failure path that is trying to report it.
 *
 * @param {unknown} error @param {{redact?: string[]}} [options]
 */
export function describeFailure(error, options = {}) {
  try {
    return classifyFailure(error, options);
  } catch {
    return FAILURE_CLASSIFICATION_FALLBACK;
  }
}

/** @param {unknown} error @param {{redact?: string[]}} options */
function classifyFailure(error, options) {
  const redact = options.redact ?? [];
  // `instanceof` walks the prototype chain, so even this read is inside the
  // caller's try/catch (a proxy with a throwing getPrototypeOf trap).
  const isError = error instanceof Error;
  const name = isError
    ? asSafeIdentifierToken(readFailureField(error, "name")) ?? "Error"
    : Array.isArray(error)
      ? "List failure"
      : error === null
        ? "Null failure"
        : asObject(error)
          ? "Object failure"
          : typeof error === "undefined"
            ? "Undefined failure"
            : `${typeof error} failure`;
  const code = firstSafeIdentifierToken(
    readFailureField(error, "code"),
    readFailureField(error, "errno")
  );
  const status = firstSafeIdentifierToken(
    readFailureField(error, "status"),
    readFailureField(error, "statusCode"),
    readFailureField(error, "statusText")
  );
  // Tolerant read: a real Error can carry an own throwing `message`/`name`
  // getter (Kotlin-JS bridge proxies do), and a classifier that dies on the
  // value it is classifying would hide the very failure it reports.
  const rawMessage = isError ? readFailureField(error, "message") : undefined;
  const message = typeof rawMessage === "string" ? boundFailureDetail(rawMessage, redact) : null;
  const parts = [message ? `${name}: ${message}` : name];
  if (code) parts.push(`code=${code}`);
  if (status && status !== code) parts.push(`status=${status}`);
  return boundFailureDetail(parts.join(" · ")) ?? name;
}

/**
 * Runs one workflow boundary, preserving WHY it failed.
 *
 * The stage token stays the designed surface, but the thrown value is no
 * longer discarded: the wrapper carries it as `cause` (Error.cause) and
 * derives a bounded, credential-free `detail` line from it. Pass `redact` with
 * any run content the boundary handled (the transcript, the instruction) so it
 * can never be echoed back by an error message.
 *
 * @param {string} stage @param {() => unknown} operation
 * @param {{redact?: string[]}} [options]
 * @returns {Promise<any>}
 */
export async function runDiagnosticStage(stage, operation, options = {}) {
  try {
    return await operation();
  } catch (error) {
    throw new ReviewStageError(stage, error, { redact: options.redact });
  }
}

/**
 * Deterministic fallback title used when the model omits the title field or
 * returns a non-string.
 * @param {Array<{severity: string}>} issues
 */
export function fallbackReviewTitle(issues) {
  return issues.length
    ? `Review found ${issues.length} issue${issues.length === 1 ? "" : "s"}`
    : "Review found no issues";
}

/** @param {string} value */
export function clampTitle(value) {
  const trimmed = value.trim();
  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`
    : trimmed;
}

/** @param {unknown} message @returns {any} */
function extractText(message) {
  const record = asObject(message);
  if (!record) return "";
  if (typeof record.content === "string") return record.content.trim();
  if (typeof record.text === "string") return record.text.trim();

  const parts = Array.isArray(record.parts) ? record.parts : [];
  return parts
    .map((/** @type {any} */ part) => {
      if (typeof part === "string") return part;
      const partRecord = asObject(part);
      if (!partRecord) return "";
      return firstNonBlankString(partRecord.text, partRecord.content) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** @param {unknown} message @returns {any} */
function extractRole(message) {
  const record = asObject(message);
  const raw = record && typeof record.role === "string" ? record.role.toLowerCase() : "message";
  if (raw === "user") return "User";
  if (raw === "assistant") return "Assistant";
  if (raw === "system") return "System";
  if (raw === "tool") return "Tool";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** @param {unknown[]} messages */
export function buildTranscript(messages) {
  return messages
    .map((message, index) => {
      const text = extractText(message);
      if (!text) return "";
      return `Message ${index + 1} (${extractRole(message)}):\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/**
 * The run's own content fragments that a failure detail must never echo back:
 * every message's own text plus the composed transcript. Used as the redaction
 * list for the boundaries that handle them (t_fa7ab623).
 * @param {unknown[]} messages
 */
export function transcriptRedactionFragments(messages) {
  const ordered = Array.isArray(messages) ? messages : [];
  const fragments = [];
  for (const message of ordered) {
    const text = extractText(message);
    if (text) fragments.push(text);
  }
  const transcript = buildTranscript(ordered);
  if (transcript) fragments.push(transcript);
  return fragments;
}

/** @param {unknown} value @returns {any} */
export function normalizeReview(value) {
  let parsed = value;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  }

  const record = asObject(parsed);
  if (!record) throw new Error("Reviewer returned an invalid structured response.");

  const rawIssues = Array.isArray(record.issues) ? record.issues : [];
  const issues = rawIssues.map((item) => {
    const issue = asObject(item) ?? {};
    const rawSeverity = firstNonBlankString(issue.severity) ?? "Medium";
    const severity = rawSeverity === "High" || rawSeverity === "Low" ? rawSeverity : "Medium";
    return {
      severity,
      title: firstNonBlankString(issue.title) ?? "Review issue",
      location: firstNonBlankString(issue.location) ?? "Location not specified",
      problem: firstNonBlankString(issue.problem) ?? "No explanation supplied.",
      correction: firstNonBlankString(issue.correction) ?? "No correction supplied."
    };
  });

  const modelTitle = firstNonBlankString(record.title);
  return {
    title: modelTitle ? clampTitle(modelTitle) : fallbackReviewTitle(issues),
    summary: firstNonBlankString(record.summary) ?? (issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"} found.` : "No material issues found."),
    issues
  };
}

/** @param {string} severity */
export function severityTone(severity) {
  if (severity === "High") return "danger";
  if (severity === "Medium") return "warning";
  return "info";
}

/** @param {{summary: string, issues: Array<{severity: string, title: string, location: string, problem: string, correction: string}>}} review */
export function reviewContent(review) {
  const blocks = [
    {
      type: "callout",
      tone: review.issues.length ? "warning" : "success",
      title: review.issues.length ? `${review.issues.length} issue${review.issues.length === 1 ? "" : "s"} found` : "No material issues found",
      body: review.summary
    }
  ];

  review.issues.forEach((issue, index) => {
    blocks.push(
      { type: "divider" },
      {
        type: "callout",
        tone: severityTone(issue.severity),
        title: `${index + 1}. ${issue.severity}: ${issue.title}`,
        body: issue.location
      },
      { type: "text", title: "Problem", text: issue.problem },
      { type: "text", title: "Correction", text: issue.correction }
    );
  });

  return blocks;
}

/**
 * Completion callout body. Deliberately model-free pane copy (t_0025dae6): no
 * state names a model, including this one. The run's model provenance is still
 * recorded on the history entry's `modelLabel` — data, never rendered.
 *
 * The callout's TITLE is not emitted here any more (t_07094a37): the pane draws
 * it from its own copy table (`COPY.calloutCompleteTitle`), which is the pane's
 * single copy surface. This function's `title` field had no reader left, and an
 * unread duplicate of a user-facing string is exactly what that rule removes.
 * @param {number} count
 */
export function completionBlock(count) {
  return {
    type: "callout",
    tone: "success",
    body: `Reviewed ${count} recent message${count === 1 ? "" : "s"}.`
  };
}

/**
 * The framing sentence every revision prompt opens with. It is CONSTANT: the
 * user edits the review body, never this paragraph, and it is re-applied on
 * every send (t_db84b23e). It lives here and only here — the pane renders it as
 * static muted text above the editable field and the composer prompt is built
 * from the same export, so an edit can never reach it and the two can never
 * drift apart.
 */
export const REVISION_FRAMING = "Revise your previous response using this independent review. Check each point, correct the response where warranted, preserve anything accurate, and clearly note anything you cannot verify.";

/**
 * The two HEADING lines of the body grammar below. They live here, and
 * {@link revisionBody} builds itself from them, so the writer and the reader of
 * this document can never drift apart (t_e01f96e1).
 */
export const REVISION_SUMMARY_HEADING = "Independent review summary:";
export const REVISION_ISSUES_HEADING = "Issues:";
/**
 * The no-issues note `revisionBody` emits instead of issue blocks. It is part of
 * the grammar, so the parser names it here too.
 */
export const REVISION_NO_ISSUES_NOTE = "No material issues were identified.";

/**
 * The DERIVED review body: the `Independent review summary:` + `Issues:`
 * markdown, i.e. the revision prompt minus {@link REVISION_FRAMING} (the split
 * t_db84b23e settled). It is the edited field's initial value for a review that
 * has never been edited.
 * @param {{summary?: unknown, issues?: unknown}} review
 */
export function revisionBody(review) {
  const record = asObject(review) ?? {};
  const issues = Array.isArray(record.issues) ? record.issues : [];
  const issueText = issues.length
    ? issues.map((/** @type {any} */ issue, /** @type {number} */ index) => {
        const entry = asObject(issue) ?? {};
        return `${index + 1}. ${entry.severity}: ${entry.title}\nLocation: ${entry.location}\nProblem: ${entry.problem}\nCorrection: ${entry.correction}`;
      }).join("\n\n")
    : REVISION_NO_ISSUES_NOTE;

  return `${REVISION_SUMMARY_HEADING}\n${firstNonBlankString(record.summary) ?? "No material issues found."}\n\n${REVISION_ISSUES_HEADING}\n${issueText}`;
}

/**
 * The separator between a severity and a title, and the exact indentation and
 * labels of an issue's detail lines, are the grammar `revisionBody` writes.
 * `1. High: title` / `Location: …` / `Problem: …` / `Correction: …` — matched
 * after a `trim()`, so indentation is forgiven, and with `-`/`*`/`)`/`]`
 * accepted in place of `1.` because a bullet is a cosmetic variation of the
 * numbering, never a different block.
 */
const REVISION_ISSUE_LINE = /^(?:(\d+)[.)\]]?|[-*])\s+([A-Za-z][^:]*?)\s*:\s*(.*)$/;
const REVISION_ISSUE_DETAIL_LINE = /^(location|problem|correction)\s*:\s?(.*)$/i;

/**
 * The strict parser for the body grammar {@link revisionBody} emits (t_e01f96e1).
 *
 * This is deliberately NOT a general markdown parser — `AGENTS.md` records that
 * approach as rejected (lossy, fragile, ungated) and it stays rejected. This
 * reads the ONE document this repo writes, a grammar we control and can
 * round-trip, so the pane can draw an edited body with the same layout it gives
 * an unedited one.
 *
 * Strict about structure, forgiving about cosmetics: extra blank lines,
 * indentation variation, `-`/`*`/`)` instead of `1.`, CRLF endings and trailing
 * whitespace are all tolerated.
 *
 * The no-loss invariant it keeps: **every input line ends up in a segment**. A
 * line the grammar does not recognise becomes a `prose` segment, verbatim —
 * never dropped, never swallowed — and {@link revisionSegmentsText} re-emits
 * the segments as body text, so parse-then-re-render reproduces the input modulo
 * whitespace normalisation.
 *
 * The only lines consumed as STRUCTURAL MARKERS, i.e. not drawn as text, are the
 * grammar's own labels — the two headings `Independent review summary:` /
 * `Issues:` and the zero-issue placeholder directly under the latter — which are
 * exactly the lines the read-only structured path does not draw either. That is
 * what makes an edited and an unedited row visually identical when their text is
 * structurally the same.
 *
 * `structured` is false when nothing structural was recognised at all (all
 * prose): the caller then keeps the whole-document fallback the user was
 * promised — one verbatim paragraph, exactly the pre-1.3.10 render.
 *
 * @param {unknown} text
 * @returns {{structured: boolean, segments: Array<{kind: "summary", text: string} | {kind: "issues-heading"} | {kind: "no-issues-note"} | {kind: "issue", index: number|null, severity: string, title: string, location: string, problem: string, correction: string} | {kind: "prose", text: string}>}}
 */
export function parseRevisionBody(text) {
  const lines = (typeof text === "string" ? text : "").replace(/\r\n?/g, "\n").split("\n");
  /** @type {any[]} */
  const segments = [];
  let at = 0;
  while (at < lines.length) {
    const current = lines[at].trim();
    if (current === "") {
      at += 1;
      continue;
    }
    if (current === REVISION_SUMMARY_HEADING) {
      at += 1;
      const summary = [];
      while (at < lines.length && lines[at].trim() !== "" && lines[at].trim() !== REVISION_ISSUES_HEADING) {
        summary.push(lines[at].trim());
        at += 1;
      }
      segments.push({ kind: "summary", text: summary.join("\n") });
      continue;
    }
    if (current === REVISION_ISSUES_HEADING) {
      segments.push({ kind: "issues-heading" });
      at += 1;
      // `revisionBody`'s zero-issue placeholder is part of the GRAMMAR, not user
      // prose: it is consumed exactly like the two headings, because the
      // read-only structured path never draws it either (it draws no issue cards
      // at all for such a review). Only the placeholder DIRECTLY under the
      // heading is a marker — anywhere else the sentence is the user's own text
      // and stays a prose segment.
      if (at < lines.length && lines[at].trim() === REVISION_NO_ISSUES_NOTE) {
        segments.push({ kind: "no-issues-note" });
        at += 1;
      }
      continue;
    }
    const numbered = REVISION_ISSUE_LINE.exec(current);
    if (numbered) {
      /** @type {any} */
      const issue = {
        kind: "issue",
        index: numbered[1] === undefined ? null : Number(numbered[1]),
        severity: numbered[2].trim(),
        title: numbered[3].trim(),
        location: "",
        problem: "",
        correction: ""
      };
      at += 1;
      // The detail lines that belong to this issue: contiguous, labelled, and
      // attached to the block that precedes them. A `Location:` with no issue
      // above it never reaches this loop, so it stays prose.
      while (at < lines.length) {
        const labelled = REVISION_ISSUE_DETAIL_LINE.exec(lines[at].trim());
        if (!labelled) break;
        const key = labelled[1].toLowerCase();
        if (key === "location") issue.location = labelled[2].trim();
        else if (key === "problem") issue.problem = labelled[2].trim();
        else issue.correction = labelled[2].trim();
        at += 1;
      }
      segments.push(issue);
      continue;
    }
    // Unrecognised: a prose block, verbatim, up to the next structural start or
    // blank line. Never dropped, never swallowed.
    const prose = [];
    while (at < lines.length) {
      const candidate = lines[at].trim();
      if (
        candidate === "" ||
        candidate === REVISION_SUMMARY_HEADING ||
        candidate === REVISION_ISSUES_HEADING ||
        REVISION_ISSUE_LINE.test(candidate)
      ) {
        break;
      }
      prose.push(lines[at].trimEnd());
      at += 1;
    }
    segments.push({ kind: "prose", text: prose.join("\n") });
  }
  return {
    structured: segments.some((segment) => segment.kind === "summary" || segment.kind === "issue"),
    segments
  };
}

/**
 * The inverse of {@link parseRevisionBody}: re-emits segments as body text, so
 * `revisionSegmentsText(parseRevisionBody(text).segments)` reproduces `text`
 * modulo whitespace normalisation. This is what makes the no-loss invariant
 * checkable instead of asserted — the gate has a real function to compare
 * against.
 * @param {unknown} segments
 */
export function revisionSegmentsText(segments) {
  const parts = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const entry = asObject(segment);
    if (!entry) continue;
    if (entry.kind === "summary") parts.push(`${REVISION_SUMMARY_HEADING}\n${entry.text ?? ""}`);
    else if (entry.kind === "issues-heading") parts.push(REVISION_ISSUES_HEADING);
    else if (entry.kind === "no-issues-note") parts.push(REVISION_NO_ISSUES_NOTE);
    else if (entry.kind === "issue") {
      const lead = Number.isInteger(entry.index) ? `${entry.index}.` : "-";
      parts.push(
        `${lead} ${entry.severity}: ${entry.title}\nLocation: ${entry.location}\nProblem: ${entry.problem}\nCorrection: ${entry.correction}`
      );
    } else parts.push(String(entry.text ?? ""));
  }
  return parts.join("\n\n");
}

/**
 * Normalizes anything the pane may hold for a review (a stored history entry, a
 * pane row model, a normalized review outcome) into the one shape the prompt
 * builders read: the SAME defaults the composer path has always applied. Both
 * the field's initial value and the text the composer receives go through this
 * function, so the draft the user sees IS the derived text that would be sent
 * (t_db84b23e — one representation).
 * @param {unknown} value
 */
export function revisionReview(value) {
  const record = asObject(value) ?? {};
  return {
    summary: asNonBlankString(record.summary) ?? "No material issues found.",
    issues: Array.isArray(record.issues)
      ? record.issues.map((/** @type {any} */ issue) => {
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
      : []
  };
}

/**
 * The full revision prompt for one review: the constant framing paragraph, then
 * the body — the STORED edited body when one exists, the derived body when not
 * (that substitution is the whole point of the pane's edit feature, t_db84b23e).
 * @param {{summary?: unknown, issues?: unknown}} review
 * @param {unknown} [editedBody] the stored, user-edited body (verbatim)
 */
export function buildRevisionPrompt(review, editedBody) {
  const body = typeof editedBody === "string" && editedBody.trim() ? editedBody : revisionBody(review);
  return `${REVISION_FRAMING}\n\n${body}`;
}

/**
 * Places the revision prompt for a review in the composer via `composer.setText`
 * (replace — never auto-send) and confirms with the concise composer toast.
 * Takes whatever the caller holds for the review and normalizes it through
 * {@link revisionReview}, so an already-normalized review and a raw stored entry
 * produce the same prompt.
 *
 * @param {any} msty @param {unknown} review @param {unknown} [editedBody] stored edited body, when the review has one
 */
export async function sendReviewToComposer(msty, review, editedBody) {
  await msty.composer.setText(buildRevisionPrompt(revisionReview(review), editedBody));
  await showToast(msty, {
    title: "Review added to composer",
    tone: "success",
    durationMs: 4000
  });
}

/**
 * Shows a toast under the toast policy: an explicit durationMs is always set,
 * the body is omitted except for failure/diagnostic toasts, and every string
 * stays a single clause. Callers must pass the bare
 * `diagnostic-stage=<id>` token as the body of failure toasts.
 *
 * @param {any} msty @param {{title: string, tone?: string, body?: string, durationMs?: number}} request
 */
export async function showToast(msty, request) {
  const toast = {
    title: request.title,
    tone: request.tone ?? "default",
    durationMs: typeof request.durationMs === "number" ? request.durationMs : 4000
  };
  if (typeof request.body === "string") toast.body = request.body;
  await msty.notifications.show(toast);
}

/**
 * Runs the full independent-review workflow and returns a normalized result
 * instead of throwing raw errors. On failure the result carries the
 * diagnostic stage so callers can render `diagnostic-stage=<id>` themselves,
 * plus `detail` (the bounded, credential-free reason) and the original thrown
 * value as `cause` — the stage token is never the only information.
 *
 * @param {any} msty @param {string} instruction
 * @returns {Promise<{ok: true, review: {title: string, summary: string, issues: Array<{severity: string, title: string, location: string, problem: string, correction: string}>}, meta: {messageCount: number, modelLabel: string, completedAt: string}, chatId: string} | {ok: false, stage: string, detail: string, cause: unknown}>}
 */
export async function executeReview(msty, instruction = "") {
  try {
    const conversationId = await runDiagnosticStage("current-chat-lookup", async () => {
      const snapshot = await msty.context.getCurrentChat();
      const id = getConversationId(snapshot);
      if (!id) throw new Error("No active chat");
      return id;
    });

    const messages = await runDiagnosticStage("recent-message-retrieval", async () => {
      const recent = await msty.messages.list({
        chatId: conversationId,
        limit: MAX_MESSAGES,
        order: "desc"
      });
      const ordered = Array.isArray(recent) ? [...recent].reverse() : [];
      const transcript = buildTranscript(ordered);
      if (!transcript || isBlank(transcript)) throw new Error("No readable messages");
      return ordered;
    });

    const instructionSuffix = typeof instruction === "string" && instruction.trim()
      ? `\n\nAdditional reviewer instruction from the user:\n${instruction.trim()}`
      : "";

    const reviewerStatus = await runDiagnosticStage(
      "model-assignment-status",
      () => msty.models.getStatus(REVIEWER_ASSIGNMENT_ID)
    );
    const reviewerAssignmentConfigured = reviewerStatus?.ready === true && reviewerStatus?.configured === true && reviewerStatus?.source === "assignment";
    const modelLabel = reviewerAssignmentConfigured ? "your reviewer model" : "the current chat model";

    // One transcript build, reused for the request and as the redaction list
    // for the boundaries that handle it: a provider error message must never
    // echo the reviewed content back into a detail line.
    const transcript = buildTranscript(messages);
    const redact = [...transcriptRedactionFragments(messages), instruction];

    const request = {
      messages: [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        { role: "user", content: `Review the following transcript.${instructionSuffix}\n\n${transcript}` }
      ],
      responseFormat: {
        type: "json",
        name: "independent_review",
        strict: true,
        schema: REVIEW_SCHEMA
      },
      ...(reviewerAssignmentConfigured ? { modelAssignment: REVIEWER_ASSIGNMENT_ID } : {})
    };

    const result = await runDiagnosticStage("inference-request", () => msty.models.infer(request), { redact });
    const review = await runDiagnosticStage(
      "response-normalization",
      () => normalizeReview(result?.json ?? result?.text),
      { redact }
    );
    const meta = { messageCount: messages.length, modelLabel, completedAt: new Date().toISOString() };
    return { ok: true, review, meta, chatId: conversationId };
  } catch (error) {
    if (error instanceof ReviewStageError) {
      return { ok: false, stage: error.stage, detail: error.detail, cause: error.cause };
    }
    return { ok: false, stage: DIAGNOSTIC_FALLBACK_STAGE, detail: describeFailure(error), cause: error };
  }
}
