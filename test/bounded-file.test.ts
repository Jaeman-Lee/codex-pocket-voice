import assert from "node:assert/strict";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BoundedRegularFileError,
  readBoundedRegularFile,
} from "../src/bounded-file.js";

test("bounded file reads one private regular file through a single descriptor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-bounded-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.json");
  await writeFile(path, "private aggregate\n", { mode: 0o600 });

  const bytes = await readBoundedRegularFile(path, { maximumBytes: 64, requirePrivate: true });
  assert.equal(bytes.toString("utf8"), "private aggregate\n");
});

test("bounded file rejects symlinks, hard links, and broad private modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-bounded-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input.json");
  const linked = join(directory, "linked.json");
  const symbolic = join(directory, "symbolic.json");
  await writeFile(path, "private aggregate\n", { mode: 0o600 });
  await link(path, linked);
  await symlink(path, symbolic);

  await assert.rejects(
    readBoundedRegularFile(linked, { maximumBytes: 64, requirePrivate: true }),
    BoundedRegularFileError,
  );
  await assert.rejects(
    readBoundedRegularFile(symbolic, { maximumBytes: 64, requirePrivate: true }),
    BoundedRegularFileError,
  );
  await rm(linked);
  await chmod(path, 0o644);
  await assert.rejects(
    readBoundedRegularFile(path, { maximumBytes: 64, requirePrivate: true }),
    BoundedRegularFileError,
  );
});

test("bounded file rejects empty and oversized inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-bounded-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const empty = join(directory, "empty");
  const oversized = join(directory, "oversized");
  await writeFile(empty, "", { mode: 0o600 });
  await writeFile(oversized, "12345", { mode: 0o600 });

  await assert.rejects(
    readBoundedRegularFile(empty, { maximumBytes: 4, requirePrivate: true }),
    BoundedRegularFileError,
  );
  await assert.rejects(
    readBoundedRegularFile(oversized, { maximumBytes: 4, requirePrivate: true }),
    BoundedRegularFileError,
  );
});
