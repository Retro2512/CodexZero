import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseManifest } from "../scripts/write-release-manifest.mjs";

test("release manifest records full commits and packaged file hashes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist", "linux-x64"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "linux-x64", "codex-zero-core"), "core bytes");
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  const sourceCommit = "a".repeat(40);
  const upstreamCommit = "b".repeat(40);
  const manifest = await createReleaseManifest(root, { version: "0.9.1", platform: "linux-x64", sourceCommit, upstreamCommit });
  assert.equal(manifest.source.commit, sourceCommit);
  assert.equal(manifest.core.sourceCommit, sourceCommit);
  assert.equal(manifest.upstream.commit, upstreamCommit);
  assert.equal(manifest.files["dist/linux-x64/codex-zero-core"], crypto.createHash("sha256").update("core bytes").digest("hex"));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8")), manifest);
  assert.equal(Object.hasOwn(manifest.files, "release-manifest.json"), false);
  const reused = await createReleaseManifest(root, {
    version: "0.9.2", platform: "linux-x64", sourceCommit: "c".repeat(40),
    upstreamCommit, coreSourceCommit: sourceCommit
  });
  assert.equal(reused.source.commit, "c".repeat(40));
  assert.equal(reused.core.sourceCommit, sourceCommit);
  await assert.rejects(() => createReleaseManifest(root, { version: "0.9.1", platform: "linux-x64", sourceCommit: "short", upstreamCommit }));
});

test("release workflow wires Linux artifacts and GitHub attestations", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /asset: linux-x64/);
  assert.match(workflow, /scripts\/write-release-manifest\.mjs/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /CORE_SOURCE_COMMIT/);
  assert.match(workflow, /gh attestation verify "reusable\/\$ARCHIVE"/);
  assert.match(workflow, /CODEX_ZERO_VERIFY_ATTESTATION: '1'/);
  for (const file of ["bootstrap.sh", "bootstrap.ps1"]) {
    const script = await fs.readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.match(script, /CODEX_ZERO_VERIFY_ATTESTATION/);
    assert.match(script, /attestation verify/);
    assert.match(script, /--signer-workflow/);
  }
});
