import { test, expect, type Page } from '@playwright/test';
const workspaces = [{ path: '/projects/alpha', name: 'alpha' }, { path: '/projects/beta', name: 'beta' }];
async function mock(page: Page, options: { fail?: boolean; deferred?: boolean } = {}) {
  let runs: any[] = [];
  let complete = false;
  await page.addInitScript(() => {
    class Events { onopen: any; onmessage: any; onerror: any; constructor() { (window as any).__events = this; } }
    (window as any).EventSource = Events;
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let data: any = {};
    if (url.pathname === '/api/health') data = { ok: true, userAgent: 'internal-debug-long-version' };
    if (url.pathname === '/api/workspaces') data = { workspaces };
    if (url.pathname === '/api/threads') data = { threads: [] };
    if (url.pathname.startsWith('/api/threads/')) data = { thread: { turns: [] } };
    if (url.pathname === '/api/runs') {
      runs.push(route.request().postDataJSON());
      if (options.deferred) await new Promise(r => setTimeout(r, 200));
      if (options.fail) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      data = { operation: { id: 'op1', threadId: 'new-thread', turnId: 'turn1', cwd: '/projects/alpha', status: 'running' } };
    }
    if (url.pathname === '/api/runs/op1') data = { operation: {
      id: 'op1', threadId: 'new-thread', cwd: '/projects/alpha', status: complete ? 'completed' : 'running',
      result: complete ? { threadId: 'new-thread', finalResponse: '완료했습니다.' } : undefined,
    } };
    await route.fulfill({ json: data });
  });
  return { runs, finish: () => { complete = true; } };
}

test('failed submission preserves draft and blocks repeated clicks while starting', async ({ page }) => {
  const m = await mock(page, { fail: true, deferred: true });
  await page.goto('/');
  await expect(page.locator('#connectionText')).toHaveText('PC 연결됨');
  await page.locator('#promptInput').fill('사라지면 안 되는 요청');
  await page.locator('#sendButton').click();
  await expect(page.locator('#sendButton')).toBeDisabled();
  await expect(page.locator('.message.error')).toContainText('입력은 보관했습니다');
  expect(m.runs).toHaveLength(1);
  await expect(page.locator('#promptInput')).toHaveValue('사라지면 안 되는 요청');
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue('사라지면 안 되는 요청');
});

test('workspace choice and independent drafts survive reload; mobile options remain visible', async ({ page }) => {
  await mock(page); await page.goto('/');
  await page.locator('#promptInput').fill('alpha draft');
  await page.locator('#workspaceSelect').selectOption('/projects/beta');
  await expect(page.locator('#promptInput')).toHaveValue('');
  await page.locator('#promptInput').fill('beta draft');
  await page.reload();
  await expect(page.locator('#workspaceSelect')).toHaveValue('/projects/beta');
  await expect(page.locator('#promptInput')).toHaveValue('beta draft');
  await page.locator('#workspaceSelect').selectOption('/projects/alpha');
  await expect(page.locator('#promptInput')).toHaveValue('alpha draft');
  await expect(page.locator('.network-toggle')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#workspaceSearch').fill('alpha');
  expect(await page.locator('#workspaceSelect option').count()).toBe(1);
});

test('reload and reconnect recover completion and keep the new conversation selected', async ({ page }) => {
  const m = await mock(page); await page.goto('/');
  await page.locator('#promptInput').fill('작업 시작');
  await page.locator('#sendButton').click();
  await expect(page.locator('#threadSelect')).toHaveValue('new-thread');
  await page.reload();
  await expect(page.locator('#activityPanel')).toBeVisible();
  m.finish();
  await page.evaluate(() => { (window as any).__events.onerror(); });
  await expect(page.locator('#connectionHelp')).toBeVisible();
  await page.locator('#reconnectButton').click();
  await expect(page.locator('.message.assistant')).toContainText('완료했습니다.');
  await expect(page.locator('#threadSelect')).toHaveValue('new-thread');
  await page.locator('#promptInput').fill('이어서 진행');
  await page.locator('#sendButton').click();
  await expect.poll(() => m.runs.length).toBe(2);
  expect(m.runs[1].threadId).toBe('new-thread');
});

test('unrelated SSE runs do not lock the tab; new conversation clears prior history', async ({ page }) => {
  await mock(page); await page.goto('/');
  await expect(page.locator('#connectionText')).toHaveText('PC 연결됨');
  await page.evaluate(() => (window as any).__events.onmessage({ data: JSON.stringify({
    type: 'operation', action: 'started', operation: { id: 'other-tab', status: 'running' },
  }) }));
  await expect(page.locator('#sendButton')).toBeEnabled();
  await page.locator('#promptInput').fill('test'); await page.locator('#sendButton').click();
  await expect(page.locator('#threadSelect')).toHaveValue('new-thread');
  await page.route('**/api/runs/op1', route => route.fulfill({ status: 404, json: { error: 'Operation not found' } }));
  await page.locator('#reconnectButton').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('.message.error')).toContainText('PC 서버가 재시작');
  await page.locator('#newThreadButton').click();
  await expect(page.locator('#threadSelect')).toHaveValue('');
  await expect(page.locator('.message')).toHaveCount(0);
});

async function speech(page: Page) {
  await page.addInitScript(() => {
    class Recognition {
      onstart: any; onend: any; onresult: any;
      constructor() { (window as any).__recognition = this; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
    }
    (window as any).SpeechRecognition = Recognition;
  });
}
async function emitSpeech(page: Page, slots: { text: string; final: boolean }[], resultIndex = 0) {
  await page.evaluate(({ slots, resultIndex }) => {
    const results = slots.map(slot => Object.assign([{ transcript: slot.text }], { isFinal: slot.final }));
    (window as any).__recognition.onresult({ results, resultIndex });
  }, { slots, resultIndex });
}

test('dictation replay does not duplicate final text but preserves intentionally repeated phrases', async ({ page }) => {
  await mock(page); await speech(page); await page.goto('/');
  await expect(page.locator('#connectionText')).toHaveText('PC 연결됨');
  await page.locator('#promptInput').fill('메모:');
  await page.locator('#voiceButton').click();
  await emitSpeech(page, [{ text: '확인해 주세요', final: true }]);
  await emitSpeech(page, [{ text: '확인해 주세요', final: true }]);
  await expect(page.locator('#promptInput')).toHaveValue('메모: 확인해 주세요');
  await emitSpeech(page, [{ text: '확인해 주세요', final: true }, { text: '확인해 주세요', final: true }], 1);
  await expect(page.locator('#promptInput')).toHaveValue('메모: 확인해 주세요 확인해 주세요');
});

test('dictation interim revisions, removal and a fresh session replace only recognition results', async ({ page }) => {
  await mock(page); await speech(page); await page.goto('/');
  await expect(page.locator('#connectionText')).toHaveText('PC 연결됨');
  await page.locator('#voiceButton').click();
  await emitSpeech(page, [{ text: '프로', final: false }]);
  await emitSpeech(page, [{ text: '프로젝트 확인', final: true }, { text: '다음', final: false }]);
  await expect(page.locator('#promptInput')).toHaveValue('프로젝트 확인 다음');
  await emitSpeech(page, [{ text: '프로젝트 확인', final: true }], 1);
  await expect(page.locator('#promptInput')).toHaveValue('프로젝트 확인');
  await page.locator('#voiceButton').click();
  await page.locator('#voiceButton').click();
  await emitSpeech(page, [{ text: '완료', final: true }]);
  await emitSpeech(page, [{ text: '완료', final: true }]);
  await expect(page.locator('#promptInput')).toHaveValue('프로젝트 확인 완료');
});
