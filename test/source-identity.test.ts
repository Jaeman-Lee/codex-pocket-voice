import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SourceIdentityError,
  parseCleanSourceIdentity,
  readCleanSourceIdentity,
} from "../src/source-identity.js";

const commit = "a".repeat(40);

test("clean source identity comes from one porcelain-v2 branch snapshot", async () => {
  let calls = 0;
  const identity = await readCleanSourceIdentity(async () => {
    calls += 1;
    return `# branch.oid ${commit}\n# branch.head feature/v2-control-plane\n`;
  });
  assert.equal(calls, 1);
  assert.deepEqual(identity, { version: "2.0.0", versionCode: 20_000, commit });
});

test("source identity rejects dirty, missing, duplicate, or malformed commit evidence", () => {
  for (const output of [
    `# branch.oid ${commit}\n1 .M N... 100644 100644 100644 ${commit} ${commit} changed.ts\n`,
    "# branch.head feature/v2-control-plane\n",
    `# branch.oid ${commit}\n# branch.oid ${"b".repeat(40)}\n`,
    "# branch.oid (initial)\n# branch.head main\n",
  ]) {
    assert.throws(() => parseCleanSourceIdentity(output, "2.0.0"), SourceIdentityError);
  }
});

test("source identity rejects invalid versions and failed Git snapshots", async () => {
  assert.throws(
    () => parseCleanSourceIdentity(`# branch.oid ${commit}\n`, "2.100.0"),
    /Source version is invalid/,
  );
  await assert.rejects(
    readCleanSourceIdentity(async () => { throw new Error("private git failure"); }),
    (error: unknown) => error instanceof SourceIdentityError && !error.message.includes("private git failure"),
  );
});

test("Android field collection checks the clean candidate before and after measurement", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../scripts/android-field-acceptance.ts", import.meta.url)),
    "utf8",
  );
  const check = "requireFunctionalCandidateSource(candidate, await cleanSourceIdentity());";
  assert.equal(source.split(check).length - 1, 2);
  const measurement = source.indexOf("const report = await measureAndroidFieldAcceptance");
  const secondCheck = source.indexOf(check, source.indexOf(check) + check.length);
  const write = source.indexOf("await writeAndroidFieldReport");
  assert.ok(measurement > 0 && secondCheck > measurement && write > secondCheck);
});
