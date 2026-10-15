// Reviewer RESPONSE validation (integrates #1 — "Fix review validation and
// preserve edited text", contributed by Ashok Gelal).
// ---------------------------------------------------------------------------
// The rule this suite pins: a malformed reviewer response is a FAILURE, never a
// clean "no issues found". `normalizeReview` is the one place a model's JSON
// becomes a review, so it either produces a complete review or throws — and
// `executeReview` reports that as `response-normalization`, visibly, instead of
// rendering a false clean review.
//
//   RS1  every malformed shape throws and fails the run at
//        `response-normalization`: not an object, missing `issues`, missing or
//        blank `summary`, a non-array `issues`, a null issue, an unknown
//        severity, and any issue with a blank/non-string title, location,
//        problem or correction
//   RS2  a well-formed review normalizes intact — issues come through unchanged
//   RS3  the cosmetic shapes are still accepted: the no-issues review and a
//        response wrapped in a ```json fence
//   RS4  a missing top-level `title` keeps its fallback (it is derived, not
//        required)
import assert from "node:assert/strict";
import { executeReview, normalizeReview } from "../hermes-review-extension/review-core.js";

const issue = {
  severity: "High",
  title: "Incorrect total",
  location: "Message 2",
  problem: "The listed amounts add up to 120, not 100.",
  correction: "Change the total to 120."
};
const review = { summary: "The total needs correcting.", issues: [issue] };

let gateCount = 0;
/** @param {string} name @param {() => any} body */
const gate = async (name, body) => {
  try {
    await body();
  } catch (error) {
    console.error(`[FAIL][${name}]`);
    throw error;
  }
  gateCount += 1;
  console.log(`[PASS][${name}]`);
};

await gate("RS1", async () => {
  const invalid = [
    {},
    { error: "Review unavailable" },
    { summary: "No issues" },
    { summary: "No issues", issues: null },
    { summary: "No issues", issues: {} },
    { summary: "", issues: [] },
    { summary: 42, issues: [] },
    { ...review, issues: [null] },
    { ...review, issues: [{ ...issue, severity: "Critical" }] }
  ];
  for (const field of ["title", "location", "problem", "correction"]) {
    for (const value of [undefined, "  ", 42]) {
      invalid.push({ ...review, issues: [{ ...issue, [field]: value }] });
    }
  }

  for (const value of invalid) {
    assert.throws(() => normalizeReview(value), /invalid structured response/);
    const outcome = await executeReview({
      context: { async getCurrentChat() { return { id: "chat-a" }; } },
      messages: { async list() { return [{ role: "assistant", content: "The total is 100." }]; } },
      models: {
        async getStatus() { return { ready: true, configured: false, source: "fallback" }; },
        async infer() { return { json: value }; }
      }
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stage, "response-normalization");
  }
});

await gate("RS2", async () => {
  assert.deepEqual(normalizeReview(review).issues, [issue]);
});

await gate("RS3", async () => {
  assert.equal(normalizeReview({ summary: "No material issues found.", issues: [] }).issues.length, 0);
  assert.deepEqual(normalizeReview('```json\n' + JSON.stringify(review) + '\n```'), normalizeReview(review));
});

await gate("RS4", async () => {
  assert.equal(typeof normalizeReview(review).title, "string", "missing titles retain the existing fallback");
});

console.log(`Hermes Review response contract checks passed (${gateCount} gates).`);
