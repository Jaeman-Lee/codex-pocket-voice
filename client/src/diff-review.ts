import type { ApprovalFeedback } from "./types";

export const MAX_DIFF_REVIEW_LINES = 300;
export const MAX_DIFF_REVIEW_CHARS = 24_000;
export const MAX_DIFF_REVIEW_LINE_CHARS = 2_000;
export const MAX_APPROVAL_FEEDBACK_LINES = 8;
export const MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH = 600;
const MAX_APPROVAL_FEEDBACK_CODE_LENGTH = 500;
const MAX_APPROVAL_FEEDBACK_PATH_LENGTH = 500;
const MAX_APPROVAL_FEEDBACK_BYTES = 12 * 1024;

export type DiffReviewLineKind = "file" | "hunk" | "addition" | "deletion" | "context" | "metadata";

export interface DiffReviewLine {
  id: string;
  kind: DiffReviewLineKind;
  prefix: string;
  content: string;
  path?: string;
  oldLine?: number;
  newLine?: number;
  selectable: boolean;
  truncated: boolean;
}

export interface DiffReview {
  lines: DiffReviewLine[];
  changedLines: number;
  truncated: boolean;
}

export function parseDiffReview(input: string): DiffReview {
  const sourceTruncated = input.length > MAX_DIFF_REVIEW_CHARS;
  const source = input.slice(0, MAX_DIFF_REVIEW_CHARS);
  const rawLines = source.split("\n");
  const lineCountTruncated = rawLines.length > MAX_DIFF_REVIEW_LINES;
  const lines: DiffReviewLine[] = [];
  let currentPath = "";
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let changedLines = 0;
  let contentTruncated = false;

  rawLines.slice(0, MAX_DIFF_REVIEW_LINES).forEach((rawLine, index) => {
    const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineTruncated = raw.length > MAX_DIFF_REVIEW_LINE_CHARS;
    const displayed = lineTruncated ? `${raw.slice(0, MAX_DIFF_REVIEW_LINE_CHARS - 1)}…` : raw;
    contentTruncated ||= lineTruncated;

    const gitPath = diffGitPath(raw);
    if (gitPath) currentPath = gitPath;
    const oldPath = diffHeaderPath(raw, "--- ");
    if (oldPath && oldPath !== "/dev/null" && !currentPath) currentPath = oldPath;
    const newPath = diffHeaderPath(raw, "+++ ");
    if (newPath && newPath !== "/dev/null") currentPath = newPath;
    if (raw.startsWith("rename to ")) currentPath = raw.slice("rename to ".length).trim();

    const hunk = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push(reviewLine(index, "hunk", "", displayed, currentPath, undefined, undefined, false, lineTruncated));
      return;
    }

    const header = raw.startsWith("diff --git ") || raw.startsWith("--- ") || raw.startsWith("+++ ");
    if (header) {
      lines.push(reviewLine(index, "file", "", displayed, currentPath, undefined, undefined, false, lineTruncated));
      return;
    }
    if (oldLine !== undefined && newLine !== undefined && raw.startsWith("+") && !raw.startsWith("+++")) {
      const content = displayed.slice(1);
      lines.push(reviewLine(
        index,
        "addition",
        "+",
        content,
        currentPath,
        undefined,
        newLine,
        validFeedbackTarget(currentPath, newLine, content),
        lineTruncated,
      ));
      newLine += 1;
      changedLines += 1;
      return;
    }
    if (oldLine !== undefined && newLine !== undefined && raw.startsWith("-") && !raw.startsWith("---")) {
      const content = displayed.slice(1);
      lines.push(reviewLine(
        index,
        "deletion",
        "-",
        content,
        currentPath,
        oldLine,
        undefined,
        validFeedbackTarget(currentPath, oldLine, content),
        lineTruncated,
      ));
      oldLine += 1;
      changedLines += 1;
      return;
    }
    if (oldLine !== undefined && newLine !== undefined && raw.startsWith(" ")) {
      lines.push(reviewLine(index, "context", " ", displayed.slice(1), currentPath, oldLine, newLine, false, lineTruncated));
      oldLine += 1;
      newLine += 1;
      return;
    }
    lines.push(reviewLine(index, "metadata", "", displayed, currentPath, undefined, undefined, false, lineTruncated));
  });

  return {
    lines,
    changedLines,
    truncated: sourceTruncated || lineCountTruncated || contentTruncated,
  };
}

export function buildApprovalFeedback(
  lines: readonly DiffReviewLine[],
  comments: Readonly<Record<string, string>>,
): ApprovalFeedback | undefined {
  const reviewed = lines.flatMap((line) => {
    const comment = comments[line.id]?.replace(/\r\n?/g, "\n").trim() ?? "";
    if (!line.selectable || !line.path || !comment || comment.length > MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(comment)) return [];
    return [{
      path: line.path,
      ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }),
      ...(line.newLine === undefined ? {} : { newLine: line.newLine }),
      code: line.content.slice(0, MAX_APPROVAL_FEEDBACK_CODE_LENGTH),
      comment,
    }];
  }).slice(0, MAX_APPROVAL_FEEDBACK_LINES);
  if (reviewed.length === 0) return undefined;
  const feedback = { lines: reviewed };
  return new TextEncoder().encode(JSON.stringify(feedback)).byteLength <= MAX_APPROVAL_FEEDBACK_BYTES
    ? feedback
    : undefined;
}

function reviewLine(
  index: number,
  kind: DiffReviewLineKind,
  prefix: string,
  content: string,
  path: string,
  oldLine: number | undefined,
  newLine: number | undefined,
  selectable: boolean,
  truncated: boolean,
): DiffReviewLine {
  return {
    id: `diff-line-${index}`,
    kind,
    prefix,
    content,
    ...(path ? { path } : {}),
    ...(oldLine === undefined ? {} : { oldLine }),
    ...(newLine === undefined ? {} : { newLine }),
    selectable,
    truncated,
  };
}

function diffGitPath(line: string): string {
  const marker = line.lastIndexOf(" b/");
  return marker < 0 ? "" : line.slice(marker + 3).trim();
}

function diffHeaderPath(line: string, prefix: "--- " | "+++ "): string {
  if (!line.startsWith(prefix)) return "";
  const path = line.slice(prefix.length).split("\t", 1)[0]!.trim();
  if (path === "/dev/null") return path;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function validFeedbackPath(path: string): boolean {
  return path.length > 0
    && path.length <= MAX_APPROVAL_FEEDBACK_PATH_LENGTH
    && path === path.trim()
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validFeedbackTarget(path: string, line: number, code: string): boolean {
  return validFeedbackPath(path)
    && Number.isSafeInteger(line)
    && line >= 1
    && line <= 10_000_000
    && !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(code.slice(0, MAX_APPROVAL_FEEDBACK_CODE_LENGTH));
}
