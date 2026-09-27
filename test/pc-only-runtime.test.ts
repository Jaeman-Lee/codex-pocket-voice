import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android starts only the PC tunnel and exposes no phone runtime target", async () => {
  const [bootScript, tunnelPlugin, clientApi] = await Promise.all([
    readFile(new URL("../scripts/codex-pocket-boot.sh", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketTunnelPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../client/src/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(bootScript, /pc-codex-web start/);
  assert.doesNotMatch(bootScript, /phone-codex-web start/);
  assert.match(tunnelPlugin, /pc-codex-web/);
  assert.doesNotMatch(tunnelPlugin, /phone-codex-web/);
  assert.doesNotMatch(clientApi, /127\.0\.0\.1:8789/);
});
