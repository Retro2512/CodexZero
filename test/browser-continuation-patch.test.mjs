import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  BROWSER_CONTINUATION_GUIDANCE, patchBrowserContinuation,
  patchBrowserContinuationDocument, patchCopiedBrowserContinuation,
} from "../src/browser-continuation-patch.mjs";

const body = "Do not handle credentials. Required confirmations remain binding.\n";
const document = "# Browser Safety\n" + body;
const escaped = text => text.replaceAll("\n", "\\r\n");
const bundle = Array.from({ length: 4 }, (_, i) =>
  `environment${i}={"browser-safety":\`${escaped(document)}\`,confirmations:"unchanged",browserAuth:"unchanged"};`
).join("\n") + `\ntraining={"browser-safety-training":\`${escaped(document)}\`};`;

test("continuation guidance is additive, syntactically valid, and idempotent", () => {
  const patched = patchBrowserContinuation(bundle);
  assert.equal(patched.split(escaped(BROWSER_CONTINUATION_GUIDANCE)).length - 1, 4);
  assert.equal(patched.replaceAll(escaped(BROWSER_CONTINUATION_GUIDANCE + "\n"), ""), bundle);
  assert.equal(patchBrowserContinuation(patched), patched);
  const context = {};
  new vm.Script(patched).runInNewContext(context);
  const crlf = text => text.replaceAll("\n", "\r\n");
  assert.equal(context.environment3["browser-safety"], crlf("# Browser Safety\n" + BROWSER_CONTINUATION_GUIDANCE + "\n" + body));
  assert.equal(context.training["browser-safety-training"], crlf(document));
});

test("guidance retains authentication, confirmation, and context boundaries", () => {
  for (const instruction of [
    "do not switch contexts or copy cookies", "do not change credential protection or required confirmations",
    "Do not choose an unspecified login method", "Do not add confirmation for cookie consent",
    "verify the resulting page when observation is permitted", "actual pending request",
  ]) assert.ok(BROWSER_CONTINUATION_GUIDANCE.includes(instruction), instruction);
});

test("unexpected and partially patched bundles are rejected", () => {
  for (const source of ["", bundle + bundle, bundle.replace(escaped(document), "changed"),
    bundle.replace(escaped(document), escaped("# Browser Safety\n" + BROWSER_CONTINUATION_GUIDANCE + "\n" + body)),
    bundle.replaceAll(escaped(document), document),
    bundle + "### Browser task continuation",
  ]) assert.throws(() => patchBrowserContinuation(source), /updated browser continuation patch/);
});

test("standalone safety document preserves content and line endings", () => {
  for (const source of [document, document.replaceAll("\n", "\r\n")]) {
    const patched = patchBrowserContinuationDocument(source);
    const inserted = (BROWSER_CONTINUATION_GUIDANCE + "\n").replaceAll("\n", source.includes("\r\n") ? "\r\n" : "\n");
    assert.equal(patched.replace(inserted, ""), source);
    assert.equal(patchBrowserContinuationDocument(patched), patched);
  }
  assert.throws(() => patchBrowserContinuationDocument("unknown"), /updated browser continuation patch/);
});

async function fixture(t, safety = document) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-browser-continuation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, "resources", "cua_node", "bin", "node_modules", "@oai", "browser-desktop");
  const service = path.join(base, "scripts", "browser-service.mjs");
  const doc = path.join(base, "environment-docs", "codex-app", "browser-safety.md");
  for (const [file, text] of [[service, bundle], [doc, safety]]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return { root, service, doc };
}

test("copied application patches both documentation sources", async t => {
  const { root, service, doc } = await fixture(t);
  assert.deepEqual(await patchCopiedBrowserContinuation(root), [service, doc]);
  assert.equal(await fs.readFile(service, "utf8"), patchBrowserContinuation(bundle));
  assert.equal(await fs.readFile(doc, "utf8"), patchBrowserContinuationDocument(document));
  await patchCopiedBrowserContinuation(root);
});

test("validation failure leaves the copied application unchanged", async t => {
  const { root, service, doc } = await fixture(t, "unknown");
  await assert.rejects(patchCopiedBrowserContinuation(root), /updated browser continuation patch/);
  assert.equal(await fs.readFile(service, "utf8"), bundle);
  assert.equal(await fs.readFile(doc, "utf8"), "unknown");
});
