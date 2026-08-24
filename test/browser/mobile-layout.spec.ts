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

test("running Codex defaults to Queue and sends Steer only after explicit selection", async ({ page }) => {
  let observedSteer: Record<string, unknown> | null = null;
  await page.route("**/api/runs/*/steer", async (route) => {
    if (route.request().method() === "POST") {
      observedSteer = route.request().postDataJSON() as Record<string, unknown>;
    }
    await route.continue();
  });
  await bootPairedApp(page, { width: 320, height: 740 });
  const textarea = page.getByLabel("Codex에게 보낼 요청");
  await textarea.fill("Queue와 Steer를 구분해 주세요.");
  await page.getByRole("button", { name: "요청 전송" }).click();

  const modes = page.getByRole("group", { name: "실행 중 요청 방식" });
  await expect(modes).toBeVisible();
  await expect(modes.getByRole("button", { name: /다음에 실행/ })).toHaveAttribute("aria-pressed", "true");
  await expect(modes.getByRole("button", { name: /지금 방향 수정/ })).toHaveAttribute("aria-pressed", "false");
  await expectElementContained(page, modes);

  await textarea.fill("이 요청은 현재 작업 다음에 실행해 주세요.");
  await page.getByRole("button", { name: "요청을 대기열에 추가" }).click();
  const queue = page.getByLabel("예약 요청", { exact: true });
  await expect(queue).toContainText("이 요청은 현재 작업 다음에 실행해 주세요.");
  expect(observedSteer).toBeNull();

  await modes.getByRole("button", { name: /지금 방향 수정/ }).click();
  await expect(modes.getByRole("button", { name: /지금 방향 수정/ })).toHaveAttribute("aria-pressed", "true");
  await textarea.fill("모바일 폭 초과를 먼저 확인하는 방향으로 바꿔 주세요.");
  await page.getByRole("button", { name: "지금 방향 수정 전송" }).click();
  await expect.poll(() => observedSteer?.prompt).toBe("모바일 폭 초과를 먼저 확인하는 방향으로 바꿔 주세요.");
  await expect(page.locator(".message.user").filter({
    hasText: "모바일 폭 초과를 먼저 확인하는 방향으로 바꿔 주세요.",
  })).toBeVisible();
  await expect(queue).toContainText("대기열 1");
  await expect(modes.getByRole("button", { name: /다음에 실행/ })).toHaveAttribute("aria-pressed", "true");
  await expectShellContained(page);
});

test("API preflight confirmation stays contained and forwards only the one-time approval", async ({ page }) => {
  let observedConfirmation = "";
  await installApiPolicyFixture(page, (token) => { observedConfirmation = token; });
  await bootPairedApp(page, { width: 320, height: 740 });

  await page.getByRole("button", { name: "프로젝트와 대화 선택 열기" }).click();
  await page.getByLabel("AI 제공자 선택").selectOption("openai");
  await expect(page.getByLabel("AI 모델", { exact: true })).toHaveValue("browser-openai-model");
  await expect(page.getByLabel("API 실행 정책 상태")).toContainText("Companion 사전검사 사용");
  await page.getByLabel("Codex에게 보낼 요청").fill("API 비용 확인 후 실행해 주세요.");
  await page.getByRole("button", { name: "요청 전송" }).click();

  const review = page.getByRole("dialog", { name: "월간 API 비용 확인" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("아직 Provider 요청을 보내지 않았습니다.");
  await expect(review).toContainText("가격 확인 필요 · 추측 안 함");
  await expectElementContained(page, review.locator(".run-policy-review-card"));
  await review.getByRole("button", { name: "검토하고 이 1회 실행" }).click();
  await expect.poll(() => observedConfirmation).toBe("browser-policy-confirmation");
  await expect(review).toBeHidden();
  await expectShellContained(page);
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

async function installApiPolicyFixture(page: Page, observe: (token: string) => void): Promise<void> {
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { providers?: any[] };
    if (!Array.isArray(body.providers)) {
      await route.fulfill({ response, json: body });
      return;
    }
    body.providers = body.providers.filter((provider) => provider.id !== "openai");
    body.providers.push({
      id: "openai",
      name: "OpenAI API",
      available: true,
      status: "connected",
      detail: "Browser policy fixture",
      accounts: [{ id: "default", label: "Fixture project", connected: true }],
      loginCommand: "",
      installed: true,
      canLogin: false,
      canTest: true,
      capabilities: {
        run: true,
        resume: true,
        models: true,
        attachments: true,
        streaming: true,
        toolCalling: false,
        approvals: false,
        workspaceRead: false,
        workspaceWrite: false,
        commandExecution: false,
        usageAccounting: true,
        steering: false,
      },
      installGuide: { summary: "fixture", command: "", docsUrl: "https://example.invalid" },
    });
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/models?provider=openai", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: {
      models: [{
        id: "browser-openai-model",
        displayName: "Browser OpenAI model",
        description: "Synthetic browser-only API model",
        isDefault: true,
        defaultEffort: "medium",
        efforts: [{ id: "medium", description: "Balanced" }],
        capabilities: { tools: false, imageInput: true },
        verification: { scope: "model", conversation: "pass", projectRead: "not_tested", coding: "not_tested" },
      }],
    },
  }));
  await page.route("**/api/run-policy/preflight", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: {
      preflight: {
        snapshot: {
          schema: 1,
          providerId: "openai",
          model: "browser-openai-model",
          privacyProfile: "openai-store-false",
          evaluatedAt: new Date().toISOString(),
          configRevision: "0123456789abcdef",
          attachmentCount: 0,
          limits: { maxOutputTokens: 4_096, maxTotalTokens: 50_000, maxRunCostMicrosUsd: 1_000_000 },
          pricing: { status: "unknown", source: "unavailable" },
          usageWindow: {
            rollingDayTokens: 205_000,
            monthCostMicrosUsd: 10_500_000,
            dailyWarningReached: true,
            monthlySoftLimitReached: true,
          },
          warnings: ["최근 24시간 token 경고 기준을 넘었습니다.", "이번 달 API 비용 soft limit을 넘었습니다.", "가격 확인 필요 · 비용을 추측하지 않습니다."],
          confirmationRequired: true,
        },
        confirmationToken: "browser-policy-confirmation",
        confirmationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
  }));
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, any>;
    observe(String(body.policyConfirmation ?? ""));
    const now = new Date().toISOString();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      json: {
        operation: {
          id: "browser-openai-operation",
          providerId: "openai",
          conversationId: "browser-openai-conversation",
          runId: "browser-openai-run",
          cwd: body.cwd,
          prompt: body.prompt,
          accountId: body.accountId,
          model: body.model,
          status: "completed",
          startedAt: now,
          completedAt: now,
          result: { finalResponse: "합성 API 정책 실행 완료" },
        },
      },
    });
  });
}
