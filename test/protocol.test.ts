import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompatibleProtocol,
  CLIENT_PROTOCOL_MAXIMUM,
  CLIENT_PROTOCOL_MINIMUM,
} from "../client/src/protocol.js";

test("v2 client accepts both the v1 rollout protocol and the v2 provider protocol", () => {
  assert.equal(CLIENT_PROTOCOL_MINIMUM, 2);
  assert.equal(CLIENT_PROTOCOL_MAXIMUM, 3);
  assert.doesNotThrow(() => assertCompatibleProtocol(2, 2));
  assert.doesNotThrow(() => assertCompatibleProtocol(3, 2));
});

test("v2 client rejects protocol ranges with no overlap", () => {
  assert.throws(() => assertCompatibleProtocol(1, 1), /호환되지 않습니다/);
  assert.throws(() => assertCompatibleProtocol(4, 4), /호환되지 않습니다/);
});
