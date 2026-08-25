import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  initialMediaComposerState,
  MAX_COMPOSER_ATTACHMENTS,
  mediaComposerBusy,
  reduceMediaComposer,
  type MediaComposerState,
} from "../client/src/media-composer-state.js";
import {
  initialVoiceInputState,
  reduceVoiceInput,
  type VoiceInputState,
} from "../client/src/voice-input-state.js";
import type { MediaItem, PendingAttachment } from "../client/src/types.js";

test("voice input state keeps single-shot and hands-free recognition transitions consistent", () => {
  let state: VoiceInputState = initialVoiceInputState;
  state = reduceVoiceInput(state, { type: "begin", continuous: false });
  assert.deepEqual(state, { supported: true, dictating: true, handsFree: false });
  state = reduceVoiceInput(state, { type: "recognition_idle" });
  assert.deepEqual(state, { supported: true, dictating: false, handsFree: false });

  state = reduceVoiceInput(state, { type: "begin", continuous: true });
  assert.deepEqual(state, { supported: true, dictating: true, handsFree: true });
  const restarting = reduceVoiceInput(state, { type: "recognition_idle" });
  assert.equal(restarting, state, "hands-free mode must remain active between recognizer restarts");
  state = reduceVoiceInput(restarting, { type: "fatal_error" });
  assert.deepEqual(state, { supported: true, dictating: false, handsFree: false });

  state = reduceVoiceInput(reduceVoiceInput(state, { type: "begin", continuous: true }), {
    type: "support_changed",
    supported: false,
  });
  assert.deepEqual(state, { supported: false, dictating: false, handsFree: false });
  assert.equal(reduceVoiceInput(state, { type: "begin", continuous: false }), state);
  state = reduceVoiceInput(state, { type: "support_changed", supported: true });
  assert.deepEqual(state, { supported: true, dictating: false, handsFree: false });
});

test("media composer bounds attachments and tracks overlapping upload batches", () => {
  let state: MediaComposerState = initialMediaComposerState;
  state = reduceMediaComposer(state, { type: "begin_upload_batch" });
  state = reduceMediaComposer(state, { type: "begin_upload_batch" });
  assert.equal(mediaComposerBusy(state), true);

  for (let index = 0; index < MAX_COMPOSER_ATTACHMENTS + 1; index += 1) {
    state = reduceMediaComposer(state, {
      type: "add_placeholder",
      attachment: placeholder(`local-${index}`),
    });
  }
  assert.equal(state.attachments.length, MAX_COMPOSER_ATTACHMENTS);
  assert.deepEqual(state.attachments.map((item) => item.id), ["local-0", "local-1", "local-2", "local-3"]);

  state = reduceMediaComposer(state, { type: "upload_progress", id: "local-0", progress: 140 });
  assert.equal(state.attachments[0]?.progress, 100);
  const uploaded = media("server-0", "uploaded");
  state = reduceMediaComposer(state, {
    type: "upload_complete",
    placeholderId: "local-0",
    media: uploaded,
    previewUrl: "blob:preview",
  });
  assert.equal(state.attachments[0]?.id, "server-0");
  assert.equal(state.attachments[0]?.previewUrl, "blob:preview");
  assert.equal(state.attachments[0]?.progress, 100);

  state = reduceMediaComposer(state, { type: "server_update", media: media("server-0", "ready") });
  assert.equal(state.attachments[0]?.status, "ready");
  assert.equal(state.attachments[0]?.previewUrl, "blob:preview");
  state = reduceMediaComposer(state, { type: "finish_upload_batch" });
  assert.equal(mediaComposerBusy(state), true);
  state = reduceMediaComposer(state, { type: "finish_upload_batch" });
  assert.equal(mediaComposerBusy(state), false);
  assert.equal(reduceMediaComposer(state, { type: "finish_upload_batch" }), state);

  state = reduceMediaComposer(state, { type: "remove", id: "server-0" });
  assert.equal(state.attachments.some((item) => item.id === "server-0"), false);
  state = reduceMediaComposer(state, { type: "clear" });
  assert.deepEqual(state.attachments, []);
});

test("App delegates voice and attachment transitions to the extracted reducers", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /useReducer\(reduceVoiceInput, initialVoiceInputState\)/);
  assert.match(app, /useReducer\(reduceMediaComposer, initialMediaComposerState\)/);
  assert.match(app, /dispatchVoiceInput\(\{ type: "fatal_error" \}\)/);
  assert.match(app, /dispatchMediaComposer\(\{ type: "server_update", media/);
  assert.doesNotMatch(app, /const \[dictating, setDictating\] = useState/);
  assert.doesNotMatch(app, /const \[attachments, setAttachments\] = useState/);
});

function placeholder(id: string): PendingAttachment {
  return {
    id,
    name: `${id}.png`,
    kind: "image",
    mimeType: "image/png",
    size: 10,
    status: "uploading",
    frameCount: 0,
    progress: 0,
  };
}

function media(id: string, status: MediaItem["status"]): MediaItem {
  return {
    id,
    name: `${id}.png`,
    kind: "image",
    mimeType: "image/png",
    size: 10,
    status,
    frameCount: 0,
  };
}
