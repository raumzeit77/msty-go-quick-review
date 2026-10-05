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

assert.deepEqual(normalizeReview(review).issues, [issue]);
assert.equal(normalizeReview({ summary: "No material issues found.", issues: [] }).issues.length, 0);
assert.deepEqual(normalizeReview('```json\n' + JSON.stringify(review) + '\n```'), normalizeReview(review));
assert.equal(typeof normalizeReview(review).title, "string", "missing titles retain the existing fallback");
console.log("Hermes Review response contract checks passed.");
