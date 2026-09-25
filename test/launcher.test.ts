import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('phone launcher distinguishes SSH denial, app failure and HTTP readiness', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pocket-launcher-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'); await mkdir(bin);
  for (const [name, script] of Object.entries({
    ssh: '[ "$MOCK_SSH" != deny ]',
    nc: 'exit 1',
    curl: '[ "$MOCK_HTTP" = ready ]',
    sleep: 'exit 0',
  })) await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  function run(ssh: string, http: string) {
    return spawnSync('bash', [resolve('scripts/pc-codex-web.sh'), 'start'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_POCKET_CONFIG: join(home,'missing'),
        PC_SSH_TARGET: 'test-pc', PC_CODEX_WEB_APP: '/test-app', PC_CODEX_KEY: '', MOCK_SSH: ssh, MOCK_HTTP: http },
    });
  }
  const denied = run('deny', 'ready'); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /공개키 등록/);
  const unavailable = run('ok', 'down'); assert.notEqual(unavailable.status, 0); assert.match(unavailable.stderr, /앱이 응답하지 않습니다/);
  const ready = run('ok', 'ready'); assert.equal(ready.status, 0); assert.match(ready.stdout, /백그라운드 연결됨/);
});
