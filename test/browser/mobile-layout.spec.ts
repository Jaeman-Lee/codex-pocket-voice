/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from "@playwright/test";

const PAIRING_CODE = "12345678";

test("the paired shell stays inside 320, 360, and 412px portrait viewports", async ({ page }) => {
  await bootPairedApp(page, { width: 320, height: 740 });

  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 780 });
    await settleLayout(page);
    await expectShellContained(page);
    await expect(page.getByRole("button", { name: "프로젝트 작업 대시보드 열기" })).toBeVisible();
    await expect(page.getByLabel("Codex에게 보낼 요청")).toBeVisible();
    await expectElementContained(page, page.locator(".composer-wrap"));
  }
});

test("large text contains a long live diff and approval details", async ({ page }) => {
  await bootPairedApp(page, { width: 320, height: 780 });
  const largeTextStylesheet = "/__browser-fixture__/large-text.css";
  await page.route(`**${largeTextStylesheet}`, (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "html { font-size: 150% !important; }",
  }));
  await page.addStyleTag({ url: largeTextStylesheet });
  await settleLayout(page);
  await expectShellContained(page);

  const prompt = `긴 diff 모바일 배치를 검증해 주세요 ${"synthetic-unbroken-prompt-".repeat(24)}`;
  await page.getByLabel("Codex에게 보낼 요청").fill(prompt);
  await page.getByRole("button", { name: "요청 전송" }).click();

  const activity = page.locator(".activity-panel");
  const liveDiff = activity.locator("pre");
  await expect(liveDiff).toContainText("diff --git");
  await expect(liveDiff).toContainText("unbroken-layout-token");
  await expectShellContained(page);
  await expectElementContained(page, activity);
  await expectElementContained(page, liveDiff);

  const dashboard = page.getByRole("dialog", { name: "작업 대시보드" });
  await expect(dashboard).toBeVisible();
  await expect(dashboard.getByText("긴 경로를 포함한 합성 변경 검토")).toBeVisible();
  const approvalDetails = dashboard.locator(".approval-card pre");
  await expect(approvalDetails).toContainText("browser-layout-only");
  await expect(approvalDetails).toContainText("diff --git");
  await approvalDetails.scrollIntoViewIfNeeded();
  await settleLayout(page);
  await expectShellContained(page);
  await expectElementContained(page, dashboard.locator(".operations-sheet"));
  await expectElementContained(page, approvalDetails);

  await dashboard.getByRole("button", { name: "거절" }).click();
  await expect(dashboard.locator(".approval-card")).toHaveCount(0);
  await dashboard.getByRole("button", { name: "작업 대시보드 닫기" }).click();
  await expect(activity).toBeHidden({ timeout: 8_000 });
  await expectShellContained(page);
});

test("focused input remains reachable through keyboard resize and landscape rotation", async ({ page }) => {
  await bootPairedApp(page, { width: 360, height: 740 });
  const textarea = page.getByLabel("Codex에게 보낼 요청");
  await textarea.fill("키보드 축소 뷰포트에서도 이 입력은 보여야 합니다.");
  await textarea.focus();

  await page.setViewportSize({ width: 360, height: 360 });
  await textarea.scrollIntoViewIfNeeded();
  await settleLayout(page);
  await expect(textarea).toBeFocused();
  await expectShellContained(page);
  await expectElementContained(page, textarea);
  await expectElementContained(page, page.locator(".composer-wrap"));
  await expectVisualViewportMatchesWindow(page);

  await page.setViewportSize({ width: 412, height: 320 });
  await textarea.scrollIntoViewIfNeeded();
  await settleLayout(page);
  await expect(textarea).toBeFocused();
  await expectShellContained(page);
  await expectElementContained(page, textarea);
  await expectElementContained(page, page.locator(".composer-wrap"));
  await expectVisualViewportMatchesWindow(page);
});

async function bootPairedApp(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.setItem("codex-pocket-onboarding-complete", "true");
    localStorage.removeItem("codex-pocket-controls-open");
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const pairing = page.getByRole("dialog", { name: /페어링$/ });
  await expect(pairing).toBeVisible();
  await expectElementContained(page, pairing.locator(".pairing-card"));
  await pairing.getByLabel("8자리 페어링 코드").fill(PAIRING_CODE);
  await pairing.getByRole("button", { name: "안전하게 연결" }).click();
  await expect(pairing).toBeHidden();
  await expect(page.locator(".status-dot.online")).toBeVisible();
  await expectShellContained(page);
}

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolvePromise) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()));
  }));
}

async function expectShellContained(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) throw new Error("app shell is missing");
    const rect = shell.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
      shell: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    };
  });
  const evidence = JSON.stringify(layout);
  expect(layout.documentWidth, evidence).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.bodyWidth, evidence).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.documentHeight, evidence).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.bodyHeight, evidence).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.shell.left, evidence).toBeGreaterThanOrEqual(-1);
  expect(layout.shell.top, evidence).toBeGreaterThanOrEqual(-1);
  expect(layout.shell.right, evidence).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.shell.bottom, evidence).toBeLessThanOrEqual(layout.viewportHeight + 1);
}

async function expectElementContained(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const [box, viewport] = await Promise.all([locator.boundingBox(), Promise.resolve(page.viewportSize())]);
  expect(box, "visible element must have a bounding box").not.toBeNull();
  expect(viewport, "browser context must have a viewport").not.toBeNull();
  if (!box || !viewport) return;
  const evidence = JSON.stringify({ box, viewport });
  expect(box.x, evidence).toBeGreaterThanOrEqual(-1);
  expect(box.y, evidence).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, evidence).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, evidence).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectVisualViewportMatchesWindow(page: Page): Promise<void> {
  const viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualWidth: window.visualViewport?.width ?? window.innerWidth,
    visualHeight: window.visualViewport?.height ?? window.innerHeight,
  }));
  expect(Math.abs(viewport.visualWidth - viewport.innerWidth), JSON.stringify(viewport)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewport.visualHeight - viewport.innerHeight), JSON.stringify(viewport)).toBeLessThanOrEqual(1);
}
