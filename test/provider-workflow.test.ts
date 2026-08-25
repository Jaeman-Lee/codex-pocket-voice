import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowRoot = new URL("../.github/workflows/", import.meta.url);

test("registered Linux workflow dispatches no Provider unless one is explicitly selected", async () => {
  const workflow = await readFile(new URL("ci.yml", workflowRoot), "utf8");
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      provider:/);
  assert.match(workflow, /provider:[\s\S]*?default: none[\s\S]*?options:\n          - none\n          - openai\n          - openrouter/);
  assert.match(
    workflow,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.provider == 'openai' \}\}/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.provider == 'openrouter' \}\}/,
  );
  assert.match(workflow, /needs: test\n    if:/g);
  assert.equal(workflow.match(/secrets: inherit/g)?.length, 2);
  assert.equal(workflow.match(/uses: \.\/\.github\/workflows\/(?:openai|openrouter)-smoke\.yml/g)?.length, 2);
  assert.equal(
    workflow.match(/execution_confirmation: \$\{\{ inputs\.execution_confirmation \}\}/g)?.length,
    2,
  );
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|OPENROUTER_API_KEY/);
});

test("Provider smoke workflows are reusable, serialized, and retain protected environment boundaries", async () => {
  const [openai, openrouter] = await Promise.all([
    readFile(new URL("openai-smoke.yml", workflowRoot), "utf8"),
    readFile(new URL("openrouter-smoke.yml", workflowRoot), "utf8"),
  ]);
  for (const [provider, workflow] of [["openai", openai], ["openrouter", openrouter]] as const) {
    assert.match(workflow, /workflow_call:\n    inputs:/, `${provider} must be reusable before merge`);
    assert.match(workflow, /workflow_dispatch:\n    inputs:/, `${provider} must remain directly dispatchable after merge`);
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.match(workflow, /environment: provider-smoke/);
    assert.match(workflow, new RegExp(`group: ${provider}-protected-smoke`));
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /PROVIDER_SMOKE_ENVIRONMENT_READY: \$\{\{ vars\.PROVIDER_SMOKE_ENVIRONMENT_READY \}\}/);
    assert.match(workflow, /PROVIDER_SMOKE_EXECUTION_CONFIRMATION: \$\{\{ inputs\.execution_confirmation \}\}/);
    assert.match(workflow, /test "\$PROVIDER_SMOKE_ENVIRONMENT_READY" = "PROTECTED_PROVIDER_SMOKE_V1"/);
    assert.match(workflow, /test "\$PROVIDER_SMOKE_EXECUTION_CONFIRMATION" = "RUN_BOUNDED_PROVIDER_SMOKE"/);
    assert.ok(
      workflow.indexOf("Verify protected execution gate") < workflow.indexOf("Check out source"),
      `${provider} must fail before checkout or inference when the protected environment is not ready`,
    );
  }
  assert.match(openai, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(openrouter, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
});
