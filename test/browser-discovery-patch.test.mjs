import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patchBrowserDiscovery, patchCopiedBrowserService } from "../src/browser-discovery-patch.mjs";

const original = "async function Yce(e,t,r,n){let l=await Promise.all(s.map(b=>Qce(e,b,a.get(b),t,n))),u=new Set(s);return{candidatePipeCount:l.length}}";
const serial = "async function Yce(e,t,r,n){let l=[];for(let b of s)l.push(await Qce(e,b,a.get(b),t,n));let u=new Set(s);return{candidatePipeCount:l.length}}";

test("browser discovery probes backends in order rather than all at once", () => {
  assert.equal(patchBrowserDiscovery(original), serial);
  assert.equal(patchBrowserDiscovery(serial), serial);
  new Function(serial);
});

test("browser discovery rejects an unrecognized upstream bundle", () => {
  assert.throws(() => patchBrowserDiscovery("async function Yce(e,t,r,n){return{candidatePipeCount:0}}"), /updated Browser Use discovery patch/);
  assert.throws(() => patchBrowserDiscovery(original + original), /updated Browser Use discovery patch/);
});

test("copied browser service is patched without changing its other content", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-browser-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = path.join(root, "resources", "cua_node", "bin", "node_modules", "@oai", "browser-desktop", "scripts", "browser-service.mjs");
  await fs.mkdir(path.dirname(service), { recursive: true });
  await fs.writeFile(service, `before;${original};after`);
  assert.equal(await patchCopiedBrowserService(root), service);
  assert.equal(await fs.readFile(service, "utf8"), `before;${serial};after`);
  assert.equal(await patchCopiedBrowserService(root), service);
});
