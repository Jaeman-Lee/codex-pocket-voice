import assert from "node:assert/strict";
import test from "node:test";
import {
  isRecentBackupPinObservation,
  pocketLinkSecurityStatus,
  POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS,
} from "../client/src/pocket-link-rotation";
import type { PocketLinkStatus } from "../client/src/native";

const backupStatus = (pinObservedAt: number): PocketLinkStatus => ({
  configured: true,
  running: true,
  transport: "pocketlink",
  pinSlot: "backup",
  pinObservedAt,
});

test("backup pin promotion requires a successful observation no older than two minutes", () => {
  const now = 1_800_000;
  assert.equal(isRecentBackupPinObservation(backupStatus(now), now), true);
  assert.equal(
    isRecentBackupPinObservation(backupStatus(now - POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS), now),
    true,
  );
  assert.equal(
    isRecentBackupPinObservation(backupStatus(now - POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS - 1), now),
    false,
  );
  assert.equal(isRecentBackupPinObservation(backupStatus(now + 1), now), false);
  assert.equal(isRecentBackupPinObservation({
    ...backupStatus(now),
    pinSlot: "primary",
  }, now), false);
  assert.equal(isRecentBackupPinObservation({
    ...backupStatus(now),
    error: "Companion 인증서 검증에 실패했습니다.",
  }, now), false);
});

test("PocketLink status text distinguishes primary, fresh backup, and expired backup observations", () => {
  const now = 1_800_000;
  assert.equal(pocketLinkSecurityStatus(undefined, now), "PocketLink TLS · 상태 확인 중");
  assert.equal(pocketLinkSecurityStatus({
    ...backupStatus(now),
    pinSlot: "primary",
  }, now), "PocketLink TLS · 기본 pin 확인");
  assert.equal(pocketLinkSecurityStatus(backupStatus(now - 1_000), now), "PocketLink TLS · 새 인증서 확인됨");
  assert.equal(
    pocketLinkSecurityStatus(backupStatus(now - POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS - 1), now),
    "PocketLink TLS · 새 인증서 확인 만료",
  );
  assert.equal(pocketLinkSecurityStatus({
    ...backupStatus(now),
    route: "relay",
    pinSlot: "primary",
  }, now), "PocketLink relay · 기본 pin 확인");
  assert.equal(pocketLinkSecurityStatus({
    ...backupStatus(now),
    route: "auto",
    lastVerifiedRoute: "direct",
    pinSlot: "primary",
  }, now), "PocketLink 자동→LAN · 기본 pin 확인");
  assert.equal(pocketLinkSecurityStatus({
    ...backupStatus(now),
    route: "auto",
    lastVerifiedRoute: "relay",
    pinSlot: "primary",
  }, now), "PocketLink 자동→relay · 기본 pin 확인");
});
