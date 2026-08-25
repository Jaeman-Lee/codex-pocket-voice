import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApprovalFeedback,
  MAX_APPROVAL_FEEDBACK_LINES,
  MAX_DIFF_REVIEW_LINES,
  parseDiffReview,
} from "../client/src/diff-review.js";

test("unified diff review tracks files, hunks, and old/new line numbers", () => {
  const review = parseDiffReview([
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -10,3 +10,3 @@ function run() {",
    " keep();",
    "-unsafe();",
    "+safe();",
  ].join("\n"));
  assert.equal(review.changedLines, 2);
  assert.deepEqual(
    review.lines.filter((line) => line.selectable).map(({ kind, path, oldLine, newLine, content }) => (
      { kind, path, oldLine, newLine, content }
    )),
    [
      { kind: "deletion", path: "src/example.ts", oldLine: 11, newLine: undefined, content: "unsafe();" },
      { kind: "addition", path: "src/example.ts", oldLine: undefined, newLine: 11, content: "safe();" },
    ],
  );
});

test("unified diff review normalizes CRLF before building server-safe feedback", () => {
  const review = parseDiffReview([
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "-old();",
    "+new();",
  ].join("\r\n"));
  const changed = review.lines.filter((line) => line.selectable);
  assert.deepEqual(changed.map((line) => line.content), ["old();", "new();"]);
  const feedback = buildApprovalFeedback(review.lines, Object.fromEntries(changed.map((line) => [line.id, "검토 의견"])));
  assert.deepEqual(feedback?.lines.map((line) => line.code), ["old();", "new();"]);
});

test("diff review handles creation, batch files, and bounded hostile lines", () => {
  const review = parseDiffReview([
    "--- /dev/null",
    "+++ b/created.txt",
    "@@ -0,0 +1,1 @@",
    "+created",
    "",
    "--- a/second.txt",
    "+++ b/second.txt",
    "@@ -2,1 +2,1 @@",
    "-before",
    "+after",
    ...Array.from({ length: MAX_DIFF_REVIEW_LINES + 2 }, () => `+${"x".repeat(2_100)}`),
  ].join("\n"));
  assert.equal(review.truncated, true);
  assert.ok(review.lines.length > 0 && review.lines.length <= MAX_DIFF_REVIEW_LINES);
  assert.equal(review.lines.find((line) => line.content === "created")?.path, "created.txt");
  assert.equal(review.lines.find((line) => line.content === "after")?.path, "second.txt");
});

test("diff review renders but does not select paths the server will reject", () => {
  const cases = [
    "/absolute.ts",
    "../escape.ts",
    "dir\\windows.ts",
    " src/leading-space.ts",
    `src/${"x".repeat(500)}.ts`,
  ];
  for (const path of cases) {
    const review = parseDiffReview([
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    assert.equal(review.changedLines, 2);
    assert.equal(review.lines.some((line) => line.selectable), false, path);
  }
});

test("diff review does not select unsafe line numbers or control-bearing code", () => {
  const invalidLine = parseDiffReview([
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -0 +10000001 @@",
    "-old",
    "+new",
  ].join("\n"));
  assert.equal(invalidLine.lines.some((line) => line.selectable), false);
  const invalidCode = parseDiffReview([
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1 +1 @@",
    "+unsafe\u0001code",
  ].join("\n"));
  assert.equal(invalidCode.lines.some((line) => line.selectable), false);
});

test("line comments build a bounded decline feedback payload only for changed lines", () => {
  const review = parseDiffReview([
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " context",
  ].join("\n"));
  const comments = Object.fromEntries(review.lines.map((line, index) => [line.id, index < 2 ? "ignored" : ` 의견 ${index} `]));
  const feedback = buildApprovalFeedback(review.lines, comments);
  assert.equal(feedback?.lines.length, 2);
  assert.deepEqual(feedback?.lines.map((line) => line.comment), ["의견 3", "의견 4"]);

  const many = parseDiffReview([
    "--- a/app.ts", "+++ b/app.ts", `@@ -1,${MAX_APPROVAL_FEEDBACK_LINES + 2} +1,0 @@`,
    ...Array.from({ length: MAX_APPROVAL_FEEDBACK_LINES + 2 }, (_, index) => `-line ${index}`),
  ].join("\n"));
  const bounded = buildApprovalFeedback(many.lines, Object.fromEntries(many.lines.map((line) => [line.id, "fix"])))!;
  assert.equal(bounded.lines.length, MAX_APPROVAL_FEEDBACK_LINES);

  const oversized = buildApprovalFeedback(
    many.lines,
    Object.fromEntries(many.lines.map((line) => [line.id, "한".repeat(600)])),
  );
  assert.equal(oversized, undefined);
  assert.equal(buildApprovalFeedback(review.lines, Object.fromEntries(
    review.lines.map((line) => [line.id, "invalid\u0001comment"]),
  )), undefined);
});
