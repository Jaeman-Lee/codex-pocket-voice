import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AI connection center stays inside the mobile viewport and scrolls internally", async () => {
  const css = await readFile(new URL("../client/src/styles.css", import.meta.url), "utf8");
  const overlay = css.match(/\.connection-center \{([^}]+)\}/)?.[1] ?? "";
  const sheet = css.match(/\.connection-center-sheet \{([^}]+)\}/)?.[1] ?? "";

  assert.match(overlay, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(overlay, /overflow:\s*hidden/);
  assert.match(sheet, /max-height:\s*100%/);
  assert.match(sheet, /overflow-y:\s*auto/);
});
