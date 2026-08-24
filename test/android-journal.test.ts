import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginUrl = new URL(
  "../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketJournalPlugin.java",
  import.meta.url,
);

test("Android journal uses app-owned SQLite and accepts encrypted envelopes only", async () => {
  const [plugin, activity] = await Promise.all([
    readFile(pluginUrl, "utf8"),
    readFile(new URL(
      "../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/MainActivity.java",
      import.meta.url,
    ), "utf8"),
  ]);

  assert.match(activity, /registerPlugin\(PocketJournalPlugin\.class\)/);
  assert.match(plugin, /extends SQLiteOpenHelper/);
  assert.match(plugin, /codex_pocket_work_journal\.db/);
  assert.match(plugin, /journal_key TEXT PRIMARY KEY/);
  assert.match(plugin, /device_id TEXT PRIMARY KEY/);
  assert.match(plugin, /scope_id TEXT PRIMARY KEY/);
  assert.match(plugin, /DATABASE_VERSION = 2/);
  assert.match(plugin, /oldVersion == 1 && newVersion == 2/);
  assert.match(plugin, /createSpeechGlossaries\(database\)/);
  assert.match(plugin, /CONFLICT_REPLACE/);
  assert.match(plugin, /envelope\.length\(\) == 3/);
  assert.match(plugin, /version instanceof Number/);
  assert.match(plugin, /optString\("ciphertext"/);
  assert.match(plugin, /\[a-f0-9\]\{64\}/);
  assert.match(plugin, /column \+ " = \?"/);
  assert.match(plugin, /new String\[\] \{ key \}/);
  assert.match(plugin, /ContentValues/);
  assert.doesNotMatch(plugin, /rawQuery/);
});
