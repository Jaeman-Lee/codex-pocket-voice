import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APP_VERSION } from "../src/version.js";

test("application version has one package source of truth", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(APP_VERSION, packageJson.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});
