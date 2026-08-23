import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APP_VERSION,
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_MINIMUM,
  GATEWAY_PROTOCOL_VERSION,
} from "../src/version.js";

test("application version has one package source of truth", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(APP_VERSION, packageJson.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(GATEWAY_PROTOCOL_VERSION, 3);
  assert.equal(GATEWAY_PROTOCOL_MINIMUM, 2);
  assert.equal(GATEWAY_CAPABILITIES.providerRuntime, true);
  assert.equal(GATEWAY_CAPABILITIES.eventReplay, true);
  assert.equal(GATEWAY_CAPABILITIES.approvalBroker, true);
  assert.equal(GATEWAY_CAPABILITIES.usageAccounting, true);
  assert.equal(GATEWAY_CAPABILITIES.journalManagement, true);
});
