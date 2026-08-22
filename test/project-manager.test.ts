import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PathPolicy } from "../src/path-policy.js";
import { ProjectCreationError, ProjectManager } from "../src/project-manager.js";

test("ProjectManager creates a git project only inside configured roots", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-pocket-projects-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const projects = await ProjectManager.fromEnvironment(paths, parent);

  const created = await projects.create("새-프로젝트", parent);
  assert.equal(created.name, "새-프로젝트");
  assert.equal(created.gitInitialized, true);
  assert.equal((await stat(join(created.path, ".git"))).isDirectory(), true);
  assert.equal(paths.isAllowed(created.path), true);

  await assert.rejects(
    projects.create("../outside", parent),
    (error: unknown) => error instanceof ProjectCreationError && error.statusCode === 400,
  );
  await assert.rejects(
    projects.create("another", join(parent, "not-allowed")),
    (error: unknown) => error instanceof ProjectCreationError && error.statusCode === 400,
  );
});

test("ProjectManager creates a configured project location when it is missing", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-project-location-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const creationRoot = join(sandbox, "workspace");
  const paths = await PathPolicy.fromEnvironment(sandbox);
  const projects = await ProjectManager.fromEnvironment(paths, creationRoot);

  assert.deepEqual(projects.creationLocations(), [{ path: await realpath(creationRoot), name: "workspace" }]);
});
