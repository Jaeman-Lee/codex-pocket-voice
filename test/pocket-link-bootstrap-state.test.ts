import assert from "node:assert/strict";
import test from "node:test";
import {
  initialPocketLinkBootstrapState,
  reducePocketLinkBootstrap,
} from "../client/src/pocket-link-bootstrap-state.js";
import type { PocketLinkDiscoveryCandidate } from "../client/src/pocket-link-discovery.js";
import type { PocketLinkP2pCandidate } from "../client/src/pocket-link-p2p.js";
import type { PendingPocketLinkBootstrap } from "../client/src/pocket-link-pairing.js";

const qr: PendingPocketLinkBootstrap = {
  version: 1,
  host: "192.168.10.8",
  port: 8789,
  serverPublicKeyPin: `sha256/${"A".repeat(43)}=`,
  pairingCode: "12345678",
  deviceId: "device-12345678",
  deviceName: "작업실 Linux",
  expiresAt: "2026-08-24T12:10:00.000Z",
};

const candidate: PocketLinkDiscoveryCandidate = {
  name: "작업실 Linux",
  host: "192.168.10.8",
  port: 8789,
  expiresAt: Date.parse("2026-08-24T12:02:00.000Z"),
};

const p2pCandidate: PocketLinkP2pCandidate = {
  id: "AbCdEfGhIjKlMnOpQrStUvWx",
  name: "작업실 Linux",
  expiresAt: Date.parse("2026-08-24T12:02:00.000Z"),
};

test("PocketLink bootstrap state keeps QR and LAN trust hints mutually exclusive", () => {
  const scanning = reducePocketLinkBootstrap(initialPocketLinkBootstrapState, { type: "start_qr" });
  assert.equal(scanning.phase, "scanning_qr");

  const reviewedQr = reducePocketLinkBootstrap(scanning, { type: "review_qr", bootstrap: qr });
  assert.deepEqual(reviewedQr, { ...initialPocketLinkBootstrapState, pendingQr: qr });

  const discovering = reducePocketLinkBootstrap(reviewedQr, { type: "start_discovery" });
  assert.equal(discovering.phase, "discovering_lan");
  assert.equal(discovering.pendingQr, null);

  const reviewedLan = reducePocketLinkBootstrap(discovering, {
    type: "review_discovery",
    candidates: [candidate],
  });
  assert.deepEqual(reviewedLan.discoveryCandidates, [candidate]);
  assert.equal(reviewedLan.pendingQr, null);

  const selected = reducePocketLinkBootstrap(reviewedLan, {
    type: "select_discovery",
    candidate,
    now: candidate.expiresAt - 1,
  });
  assert.equal(selected.selectedDiscovery, candidate);
  assert.equal(reducePocketLinkBootstrap(selected, { type: "invalidate_discovery" }).selectedDiscovery, null);
});

test("PocketLink bootstrap state rejects stale async results and unknown or expired candidates", () => {
  assert.equal(
    reducePocketLinkBootstrap(initialPocketLinkBootstrapState, { type: "review_qr", bootstrap: qr }),
    initialPocketLinkBootstrapState,
  );
  assert.equal(
    reducePocketLinkBootstrap(initialPocketLinkBootstrapState, {
      type: "review_discovery",
      candidates: [candidate],
    }),
    initialPocketLinkBootstrapState,
  );

  const discovering = reducePocketLinkBootstrap(initialPocketLinkBootstrapState, { type: "start_discovery" });
  assert.equal(reducePocketLinkBootstrap(discovering, { type: "start_qr" }), discovering);
  const reviewed = reducePocketLinkBootstrap(discovering, { type: "review_discovery", candidates: [candidate] });
  const unknown = { ...candidate, host: "192.168.10.9" };
  assert.equal(reducePocketLinkBootstrap(reviewed, {
    type: "select_discovery",
    candidate: unknown,
    now: candidate.expiresAt - 1,
  }), reviewed);
  assert.equal(reducePocketLinkBootstrap(reviewed, {
    type: "select_discovery",
    candidate,
    now: candidate.expiresAt,
  }), reviewed);
});

test("PocketLink bootstrap state keeps an opaque P2P selection alongside a LAN or QR trust hint", () => {
  const discoveringP2p = reducePocketLinkBootstrap(initialPocketLinkBootstrapState, { type: "start_p2p" });
  assert.equal(discoveringP2p.phase, "discovering_p2p");
  const reviewedP2p = reducePocketLinkBootstrap(discoveringP2p, {
    type: "review_p2p",
    candidates: [p2pCandidate],
  });
  const selectedP2p = reducePocketLinkBootstrap(reviewedP2p, {
    type: "select_p2p",
    candidate: p2pCandidate,
    now: p2pCandidate.expiresAt - 1,
  });
  assert.equal(selectedP2p.selectedP2p, p2pCandidate);

  const scanning = reducePocketLinkBootstrap(selectedP2p, { type: "start_qr" });
  const reviewedQr = reducePocketLinkBootstrap(scanning, { type: "review_qr", bootstrap: qr });
  assert.equal(reviewedQr.selectedP2p, p2pCandidate);
  assert.equal(reviewedQr.pendingQr, qr);

  const discoveringLan = reducePocketLinkBootstrap(reviewedQr, { type: "start_discovery" });
  const reviewedLan = reducePocketLinkBootstrap(discoveringLan, {
    type: "review_discovery",
    candidates: [candidate],
  });
  assert.equal(reviewedLan.selectedP2p, p2pCandidate);
  assert.deepEqual(reviewedLan.discoveryCandidates, [candidate]);
  assert.equal(reducePocketLinkBootstrap(reviewedLan, { type: "invalidate_p2p" }).selectedP2p, null);
});

test("PocketLink registration preserves only a reviewed QR bound to the new target", () => {
  const scanning = reducePocketLinkBootstrap(initialPocketLinkBootstrapState, { type: "start_qr" });
  const reviewed = reducePocketLinkBootstrap(scanning, { type: "review_qr", bootstrap: qr });
  const bound = { ...qr, targetId: "linux-pocketlink-1" };
  const registration = {
    type: "register" as const,
    targetId: "linux-pocketlink-1",
    pocketLink: true,
    host: qr.host,
    port: qr.port,
    serverPublicKeyPin: qr.serverPublicKeyPin,
  };
  const registered = reducePocketLinkBootstrap(reviewed, registration);
  assert.deepEqual(registered, { ...initialPocketLinkBootstrapState, pendingQr: bound });
  assert.equal(
    reducePocketLinkBootstrap(initialPocketLinkBootstrapState, registration).pendingQr,
    null,
  );
  assert.equal(
    reducePocketLinkBootstrap(reviewed, { ...registration, host: "192.168.10.9" }).pendingQr,
    null,
  );
  assert.deepEqual(
    reducePocketLinkBootstrap(registered, { type: "clear_qr" }),
    initialPocketLinkBootstrapState,
  );
});
