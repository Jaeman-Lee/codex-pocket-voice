import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrentPocketLinkP2pCandidate,
  parsePocketLinkP2pResult,
} from "../client/src/pocket-link-p2p.js";

const now = 1_800_000;
const candidate = {
  id: "AbCdEfGhIjKlMnOpQrStUvWx",
  name: "작업실 Linux",
  expiresAt: now + 120_000,
};

test("PocketLink P2P parser accepts bounded opaque candidates without device addresses", () => {
  assert.deepEqual(parsePocketLinkP2pResult({ candidates: [candidate], windowMs: 12_000 }, now), [candidate]);
  assert.equal(isCurrentPocketLinkP2pCandidate(candidate, now), true);
  assert.equal(isCurrentPocketLinkP2pCandidate(candidate, candidate.expiresAt), false);
});

test("PocketLink P2P parser rejects native metadata expansion, duplicate ids, and stale candidates", () => {
  assert.throws(() => parsePocketLinkP2pResult({
    candidates: [{ ...candidate, deviceAddress: "02:00:00:00:00:01" }],
    windowMs: 12_000,
  }, now));
  assert.throws(() => parsePocketLinkP2pResult({ candidates: [candidate, candidate], windowMs: 12_000 }, now));
  assert.throws(() => parsePocketLinkP2pResult({
    candidates: [{ ...candidate, expiresAt: now }],
    windowMs: 12_000,
  }, now));
  assert.throws(() => parsePocketLinkP2pResult({
    candidates: [{ ...candidate, id: "not-an-opaque-id" }],
    windowMs: 12_000,
  }, now));
});

test("PocketLink P2P parser normalizes names and enforces the discovery envelope", () => {
  assert.equal(parsePocketLinkP2pResult({
    candidates: [{ ...candidate, name: "  Cafe\u0301 Linux  " }],
    windowMs: 12_000,
  }, now)[0]?.name, "Café Linux");
  assert.throws(() => parsePocketLinkP2pResult({
    candidates: [{ ...candidate, name: "Linux\u200bPC" }],
    windowMs: 12_000,
  }, now));
  assert.throws(() => parsePocketLinkP2pResult({ candidates: [], windowMs: 8_000 }, now));
  assert.throws(() => parsePocketLinkP2pResult({
    candidates: Array.from({ length: 17 }, (_, index) => ({
      ...candidate,
      id: index.toString(36).padStart(24, "a"),
    })),
    windowMs: 12_000,
  }, now));
});
