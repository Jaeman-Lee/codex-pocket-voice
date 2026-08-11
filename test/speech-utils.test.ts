import assert from "node:assert/strict";
import test from "node:test";
import { mergeSpeechSegments } from "../client/src/speech-utils.js";

test("speech segments replace cumulative Android hypotheses instead of repeating them", () => {
  assert.equal(
    mergeSpeechSegments([
      "헬로우를",
      "헬로우를 표출하는",
      "헬로우를 표출하는 파이썬",
      "헬로우를 표출하는 파이썬 프로그램",
      "헬로우를 표출하는 파이썬 프로그램 하나 만들어",
    ]),
    "헬로우를 표출하는 파이썬 프로그램 하나 만들어",
  );
});

test("speech segments still join normal final chunks and overlapping chunks", () => {
  assert.equal(
    mergeSpeechSegments(["헬로우를 표출하는", "파이썬", "파이썬 프로그램", "프로그램 하나 만들어"]),
    "헬로우를 표출하는 파이썬 프로그램 하나 만들어",
  );
});
