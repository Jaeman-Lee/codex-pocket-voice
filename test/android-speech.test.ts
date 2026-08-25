import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android speech uses bounded project terms only as optional API 33 recognition hints", async () => {
  const plugin = await readFile(new URL(
    "../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketSpeechPlugin.java",
    import.meta.url,
  ), "utf8");

  assert.match(plugin, /MAX_BIASING_STRINGS = 32/);
  assert.match(plugin, /values\.length\(\) > MAX_BIASING_STRINGS/);
  assert.match(plugin, /MAX_BIASING_STRING_LENGTH = 120/);
  assert.match(plugin, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU/);
  assert.match(plugin, /RecognizerIntent\.EXTRA_BIASING_STRINGS/);
  assert.match(plugin, /putStringArrayListExtra/);
  assert.doesNotMatch(plugin, /Log\.[a-z]+\([^\n]*biasingStrings/);
});
