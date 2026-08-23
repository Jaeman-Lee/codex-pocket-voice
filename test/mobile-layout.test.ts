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

test("the app shell cannot grow beyond a narrow mobile viewport", async () => {
  const css = await readFile(new URL("../client/src/styles.css", import.meta.url), "utf8");
  const root = css.match(/html, body, #root \{([^}]+)\}/)?.[1] ?? "";
  const shell = css.match(/\.app-shell \{([^}]+)\}/)?.[1] ?? "";
  const shellChildren = css.match(/\.app-shell > \* \{([^}]+)\}/)?.[1] ?? "";
  const composer = css.match(/\.composer-wrap \{([^}]+)\}/)?.[1] ?? "";
  const composerBar = css.match(/\.composer-bar \{([^}]+)\}/)?.[1] ?? "";
  const unknownOperation = css.match(/\.unknown-operation \{([^}]+)\}/)?.[1] ?? "";

  assert.match(root, /max-width:\s*100%/);
  assert.match(root, /min-width:\s*0/);
  assert.match(root, /min-height:\s*0/);
  assert.match(shell, /max-width:\s*860px/);
  assert.match(shell, /max-height:\s*100%/);
  assert.match(shell, /min-width:\s*0/);
  assert.match(shellChildren, /min-width:\s*0/);
  assert.match(composer, /max-width:\s*100%/);
  assert.match(composer, /overflow-y:\s*auto/);
  assert.match(composerBar, /flex-wrap:\s*wrap/);
  assert.match(unknownOperation, /min-width:\s*0/);
  assert.match(unknownOperation, /display:\s*flex/);
  assert.doesNotMatch(css, /touch-action:\s*pan-y\s*;/);
  assert.match(css, /touch-action:\s*pan-y pinch-zoom/);
});

test("Android resizes for the keyboard and keeps user zoom available", async () => {
  const html = await readFile(new URL("../client/index.html", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  const capacitorConfig = await readFile(new URL("../capacitor.config.ts", import.meta.url), "utf8");

  assert.match(html, /minimum-scale=0\.5/);
  assert.match(html, /maximum-scale=5/);
  assert.match(html, /user-scalable=yes/);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  assert.match(capacitorConfig, /zoomEnabled:\s*true/);
});
