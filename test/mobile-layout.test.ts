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

test("OpenRouter routing controls collapse to one bounded column on phones", async () => {
  const css = await readFile(new URL("../client/src/styles.css", import.meta.url), "utf8");
  const routing = css.match(/\.routing-bar \{([^}]+)\}/)?.[1] ?? "";
  const select = css.match(/\.routing-bar select \{([^}]+)\}/)?.[1] ?? "";
  const insight = css.match(/\.model-insight \{([^}]+)\}/)?.[1] ?? "";
  const facts = css.match(/\.routing-facts \{([^}]+)\}/)?.[1] ?? "";
  assert.match(routing, /minmax\(0,\s*1fr\)/);
  assert.match(routing, /min-width:\s*0/);
  assert.match(select, /width:\s*100%/);
  assert.match(select, /min-width:\s*0/);
  assert.match(insight, /flex-wrap:\s*wrap/);
  assert.match(insight, /min-width:\s*0/);
  assert.match(facts, /min-width:\s*0/);
  assert.match(css, /\.model-insight > small[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.model-insight > span\.verified \{[^}]*color:\s*var\(--accent\)/);
  assert.match(css, /\.model-insight > span\.restricted \{[^}]*color:\s*var\(--warm\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.routing-bar \{[^}]*minmax\(0,\s*1fr\)/);
});

test("operations dashboard and approval details stay inside the mobile viewport", async () => {
  const css = await readFile(new URL("../client/src/styles.css", import.meta.url), "utf8");
  const overlay = css.match(/\.operations-dashboard \{([^}]+)\}/)?.[1] ?? "";
  const sheet = css.match(/\.operations-sheet \{([^}]+)\}/)?.[1] ?? "";
  const details = css.match(/\.approval-card pre \{([^}]+)\}/)?.[1] ?? "";
  const handoffPath = css.match(/\.handoff-summary code \{([^}]+)\}/)?.[1] ?? "";
  const journalConfirm = css.match(/\.journal-delete-confirm \{([^}]+)\}/)?.[1] ?? "";
  const journalPath = css.match(/\.journal-delete-confirm > code \{([^}]+)\}/)?.[1] ?? "";
  const pocketLinkFields = css.match(/\.pocket-link-fields \{([^}]+)\}/)?.[1] ?? "";
  const pocketRelayFields = css.match(/\.pocket-link-relay-fields \{([^}]+)\}/)?.[1] ?? "";
  const pinPromotionActions = css.match(/\.pin-promotion-review > div, \.pin-staging-review > div \{([^}]+)\}/)?.[1] ?? "";
  const pairingActions = css.match(/\.pairing-actions \{([^}]+)\}/)?.[1] ?? "";
  const operationActions = css.match(/\.operation-card-actions \{([^}]+)\}/)?.[1] ?? "";
  const operationEditor = css.match(/\.operation-name-editor \{([^}]+)\}/)?.[1] ?? "";
  const operationNameInput = css.match(/\.operation-name-editor input \{([^}]+)\}/)?.[1] ?? "";
  const retentionFields = css.match(/\.retention-policy-fields \{([^}]+)\}/)?.[1] ?? "";
  const retentionEditor = css.match(/\.retention-policy-editor \{([^}]+)\}/)?.[1] ?? "";
  const recoveryCard = css.match(/\.workspace-recovery \{([^}]+)\}/)?.[1] ?? "";
  const recoveryWorkspace = css.match(/\.workspace-recovery-transactions > li > code \{([^}]+)\}/)?.[1] ?? "";
  const recoveryPaths = css.match(/\.workspace-recovery-transactions > li > div code \{([^}]+)\}/)?.[1] ?? "";
  const recoveryActions = css.match(/\.workspace-recovery-actions \{([^}]+)\}/)?.[1] ?? "";
  const runPolicyReview = css.match(/\.run-policy-review \{([^}]+)\}/)?.[1] ?? "";
  const runPolicyReviewCard = css.match(/\.run-policy-review-card \{([^}]+)\}/)?.[1] ?? "";
  const runPolicyFields = css.match(/\.run-policy-fields \{([^}]+)\}/)?.[1] ?? "";
  const runForkReview = css.match(/\.run-fork-review \{([^}]+)\}/)?.[1] ?? "";
  const runForkReviewCard = css.match(/\.run-fork-review-card \{([^}]+)\}/)?.[1] ?? "";
  const runForkContext = css.match(/\.run-fork-context \{([^}]+)\}/)?.[1] ?? "";

  assert.match(overlay, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(overlay, /overflow:\s*hidden/);
  assert.match(sheet, /max-width:\s*100%/);
  assert.match(sheet, /max-height:\s*100%/);
  assert.match(sheet, /overflow-x:\s*hidden/);
  assert.match(sheet, /overflow-y:\s*auto/);
  assert.match(details, /max-width:\s*100%/);
  assert.match(details, /white-space:\s*pre-wrap/);
  assert.match(details, /overflow-wrap:\s*anywhere/);
  assert.match(handoffPath, /min-width:\s*0/);
  assert.match(handoffPath, /overflow-wrap:\s*anywhere/);
  assert.match(journalConfirm, /max-width:\s*100%/);
  assert.match(journalConfirm, /overflow:\s*hidden/);
  assert.match(journalPath, /overflow:\s*auto/);
  assert.match(journalPath, /white-space:\s*pre-wrap/);
  assert.match(pocketLinkFields, /min-width:\s*0/);
  assert.match(pocketLinkFields, /minmax\(0,\s*1fr\)/);
  assert.match(pocketRelayFields, /min-width:\s*0/);
  assert.match(pocketRelayFields, /minmax\(0,\s*1fr\)/);
  assert.match(css, /\.pocket-link-relay-fields \.wide \{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.pocket-link-relay-fields \{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.pocket-link-qr-review/);
  assert.match(css, /\.pocket-link-qr-scan/);
  assert.match(css, /\.pocket-link-bootstrap-actions \{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.pocket-link-discovery-list button span[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.pocket-link-bootstrap-actions \{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.pin-staging-review > input/);
  assert.match(css, /\.pin-staging-review > div\.three-actions \{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.identity-rotation-review > div \{[^}]*minmax\(0,\s*1fr\)[^}]*minmax\(0,\s*2fr\)/);
  assert.match(pinPromotionActions, /minmax\(0,\s*1fr\)/);
  assert.match(pinPromotionActions, /minmax\(0,\s*2fr\)/);
  assert.match(pairingActions, /minmax\(0,\s*1fr\)/);
  assert.match(operationActions, /minmax\(0,\s*1fr\)/);
  assert.match(operationEditor, /max-width:\s*100%/);
  assert.match(operationNameInput, /max-width:\s*100%/);
  assert.match(operationNameInput, /min-width:\s*0/);
  assert.match(retentionFields, /minmax\(0,\s*1fr\)/);
  assert.match(retentionEditor, /max-width:\s*100%/);
  assert.match(recoveryCard, /max-width:\s*100%/);
  assert.match(recoveryCard, /overflow:\s*hidden/);
  assert.match(recoveryWorkspace, /white-space:\s*pre-wrap/);
  assert.match(recoveryWorkspace, /overflow-wrap:\s*anywhere/);
  assert.match(recoveryPaths, /max-width:\s*100%/);
  assert.match(recoveryPaths, /overflow-wrap:\s*anywhere/);
  assert.match(recoveryActions, /minmax\(0,\s*0\.7fr\)/);
  assert.match(recoveryActions, /minmax\(0,\s*1\.3fr\)/);
  assert.match(runPolicyReview, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(runPolicyReview, /overflow:\s*hidden/);
  assert.match(runPolicyReviewCard, /max-width:\s*100%/);
  assert.match(runPolicyReviewCard, /max-height:\s*100%/);
  assert.match(runPolicyReviewCard, /overflow-x:\s*hidden/);
  assert.match(runPolicyReviewCard, /overflow-y:\s*auto/);
  assert.match(runPolicyFields, /minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.run-policy-review-facts, \.run-policy-review-actions, \.run-policy-fields \{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(runForkReview, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(runForkReview, /overflow:\s*hidden/);
  assert.match(runForkReviewCard, /max-width:\s*100%/);
  assert.match(runForkReviewCard, /max-height:\s*100%/);
  assert.match(runForkReviewCard, /overflow-x:\s*hidden/);
  assert.match(runForkReviewCard, /overflow-y:\s*auto/);
  assert.match(runForkContext, /overflow-x:\s*hidden/);
  assert.match(runForkContext, /overflow-y:\s*auto/);
  assert.match(css, /\.run-fork-context pre[^}]*white-space:\s*pre-wrap/);
  assert.match(css, /\.run-fork-context pre[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.run-fork-review-facts, \.run-fork-review-actions \{[^}]*minmax\(0,\s*1fr\)/);
});

test("API policy confirmation is touch-only and never persists its one-time token", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  const journal = await readFile(new URL("../client/src/work-journal-model.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../client/src/OperationsDashboard.tsx", import.meta.url), "utf8");

  assert.match(app, /\/api\/run-policy\/preflight/);
  assert.match(app, /검토하고 이 1회 실행/);
  assert.match(app, /아직 Provider 요청을 보내지 않았습니다/);
  assert.match(app, /policyConfirmation:\s*queued\.policyConfirmation/);
  assert.match(journal, /policyConfirmation:\s*_policyConfirmation/);
  assert.match(dashboard, /API 실행 긴급 중단/);
  assert.match(dashboard, /if \(!confirming\)/);
  assert.match(dashboard, /확인하고 API 정책 적용/);
});

test("Provider fork is touch-reviewed, client-bound, and does not auto-resume a conversation", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  const server = await readFile(new URL("../src/web-server.ts", import.meta.url), "utf8");
  const journal = await readFile(new URL("../client/src/work-journal-model.ts", import.meta.url), "utf8");

  assert.match(app, /\/api\/run-forks\/preview/);
  assert.match(app, /Provider 컨텍스트 Fork 확인/);
  assert.match(app, /이 범위로 새 대화 Fork/);
  assert.match(app, /forkPreviewId:\s*queued\.forkPreviewId/);
  assert.match(app, /!queued\.forkPreviewId && queued\.provider === "codex"/);
  assert.match(server, /runForks\.sourceOperationId\(forkPreviewId, authenticatedClient\.id\)/);
  assert.match(server, /Provider fork always starts a new conversation/);
  assert.match(server, /Provider fork cannot move context to another workspace/);
  assert.match(journal, /forkPreviewId:\s*_forkPreviewId/);
});

test("running Codex input defaults to Queue and exposes explicit bounded Steer controls", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../client/src/styles.css", import.meta.url), "utf8");
  const mode = css.match(/\.run-input-mode \{([^}]+)\}/)?.[1] ?? "";
  assert.match(app, /useState<"queue" \| "steer">\("queue"\)/);
  assert.match(app, /지금 방향 수정/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(current\.id\)\}\/steer/);
  assert.match(app, /current\.providerId === "codex"/);
  assert.match(app, /capabilities\.steering === true/);
  assert.match(app, /setComposerRunMode\("queue"\)/);
  assert.match(mode, /repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mode, /min-width:\s*0/);
  assert.match(css, /\.run-input-mode > small[^}]*overflow-wrap:\s*anywhere/);
});

test("workspace recovery stays fail-closed and requires a second touch", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../client/src/OperationsDashboard.tsx", import.meta.url), "utf8");

  assert.match(app, /confirm:\s*"retry-safe-workspace-recovery"/);
  assert.match(app, /workspaceRecovery\?\.blocked\s*\?\s*"!"/);
  assert.match(dashboard, /if \(!confirming\)/);
  assert.match(dashboard, /안전 복구 재시도 검토/);
  assert.match(dashboard, /확인하고 안전 복구 재시도/);
  assert.match(dashboard, /journal을 버리거나 파일을 강제로 덮어쓰거나 삭제하지 않습니다/);
  assert.match(dashboard, /pendingTransactions\.slice\(0, 8\)/);
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
