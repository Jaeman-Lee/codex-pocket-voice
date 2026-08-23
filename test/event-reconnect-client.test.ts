import assert from "node:assert/strict";
import test from "node:test";
import { EventStreamState } from "../client/src/event-stream-state.js";

test("event client replays after a reset and deduplicates cursors", () => {
  const state = new EventStreamState(5);
  const applied = [
    state.apply('data: {"type":"connected"}'),
    state.apply('data: {"type":"journal","action":"reset"}'),
    state.apply('id: 2\ndata: {"type":"provider","kind":"output.delta","delta":"a"}'),
    state.apply('id: 2\ndata: {"type":"provider","kind":"output.delta","delta":"duplicate"}'),
    state.apply('id: 3\ndata: {"type":"provider","kind":"output.delta","delta":"b"}'),
  ];
  assert.deepEqual(applied.map((item) => [item.event?.type, item.event?.delta]), [
    ["connected", undefined],
    ["journal", undefined],
    ["provider", "a"],
    [undefined, undefined],
    ["provider", "b"],
  ]);
  assert.deepEqual(applied.map((item) => item.cursorAction), [
    undefined,
    { type: "remove" },
    { type: "set", cursor: 2 },
    undefined,
    { type: "set", cursor: 3 },
  ]);
});
