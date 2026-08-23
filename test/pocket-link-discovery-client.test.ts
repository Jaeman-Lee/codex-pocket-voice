import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesPocketLinkDiscovery,
  parsePocketLinkDiscoveryResult,
} from "../client/src/pocket-link-discovery.js";

test("LAN discovery candidates stay bounded, private, and short-lived", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const [candidate] = parsePocketLinkDiscoveryResult({
    windowMs: 8_000,
    candidates: [{
      name: "작업실 Linux",
      host: "192.168.10.8",
      port: 8789,
      expiresAt: now + 120_000,
    }],
  }, now);
  assert.deepEqual(candidate, {
    name: "작업실 Linux",
    host: "192.168.10.8",
    port: 8789,
    expiresAt: now + 120_000,
  });
  assert.equal(matchesPocketLinkDiscovery(candidate!, "작업실 Linux", "192.168.10.8", 8789, now), true);
  assert.equal(matchesPocketLinkDiscovery(candidate!, "작업실 Linux", "192.168.10.8", 8789, now + 120_000), false);
});

test("LAN discovery rejects public hosts, smuggled names, duplicates, and unbounded results", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const result = (candidate: Record<string, unknown>) => ({ windowMs: 8_000, candidates: [candidate] });
  const base = { name: "Linux PC", host: "10.0.0.8", port: 8789, expiresAt: now + 120_000 };

  assert.throws(() => parsePocketLinkDiscoveryResult(result({ ...base, host: "203.0.113.8" }), now), /후보/);
  assert.throws(() => parsePocketLinkDiscoveryResult(result({ ...base, host: "010.0.0.8" }), now), /후보/);
  assert.throws(() => parsePocketLinkDiscoveryResult(result({ ...base, name: "Linux\nPC" }), now), /후보/);
  assert.throws(() => parsePocketLinkDiscoveryResult(result({ ...base, name: "Linux\u202ePC" }), now), /후보/);
  assert.throws(() => parsePocketLinkDiscoveryResult(result({ ...base, pin: "untrusted" }), now), /후보/);
  assert.throws(() => parsePocketLinkDiscoveryResult({ windowMs: 8_000, candidates: [base, base] }, now), /중복/);
  assert.throws(() => parsePocketLinkDiscoveryResult({ windowMs: 8_000, candidates: Array(17).fill(base) }, now), /결과/);
  assert.throws(() => parsePocketLinkDiscoveryResult(result({ ...base, expiresAt: now + 130_000 }), now), /후보/);
});
