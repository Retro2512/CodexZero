import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STRIPPED_CAPABILITY, STRIPPED_BUNDLED_PLUGINS, disableAnalytics, pruneCopiedDesktop, stubComponentChunk
} from "../src/lean-desktop-patch.mjs";

test("ChatGPT product capabilities are stripped while coding capabilities remain", () => {
  for (const name of ["chatgpt", "chatgpt.quick-chat", "chatgpt.seat-access", "toys.confetti", "demo-tools"]) {
    assert.ok(STRIPPED_CAPABILITY.test(name), name);
  }
  for (const name of ["dictation", "dictation.global", "browser.in-app", "automations.local", "codex.browser", "chatgptish"]) {
    assert.ok(!STRIPPED_CAPABILITY.test(name), name);
  }
});

test("every analytics setting reader sees analytics as off", () => {
  const source = "c=e=>e.analytics?.enabled!==!1,x=n==null||n.analytics?.enabled===!1";
  assert.equal(disableAnalytics(source, "fixture"), "c=e=>!1,x=n==null||!0");
  assert.throws(() => disableAnalytics("no settings here", "fixture"), /updated analytics patch/);
});

test("only chunks made entirely of stripped components are stubbed", () => {
  const stub = stubComponentChunk("import{a}from'./x.js';function L(){return a}export{L as ModelPickerUpsellModal};\n//# sourceMappingURL=modal.js.map");
  assert.equal(stub, "const czNothing=()=>null;export{czNothing as ModelPickerUpsellModal};\n");
  assert.equal(stubComponentChunk("export{L as ModelPickerUpsellModal,M as useModelPicker};"), null);
  assert.equal(stubComponentChunk("export{t as n};"), null);
  assert.equal(stubComponentChunk("const x=1;"), null);
});

test("pruning a copied desktop removes stripped plugins and keeps coding plugins", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-lean-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundled = path.join(root, "resources", "plugins", "openai-bundled");
  const names = ["codex-app-tools", "browser", ...STRIPPED_BUNDLED_PLUGINS];
  await fs.mkdir(path.join(bundled, ".agents", "plugins"), { recursive: true });
  await fs.writeFile(path.join(bundled, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ name: "openai-bundled", plugins: names.map(name => ({ name })) }));
  for (const name of names) await fs.mkdir(path.join(bundled, "plugins", name), { recursive: true });
  await fs.mkdir(path.join(root, "resources", "skills", "skills", ".curated", "hatch-pet"), { recursive: true });
  await fs.mkdir(path.join(root, "resources", "skills", "skills", ".curated", "keep-me"), { recursive: true });
  await pruneCopiedDesktop(root);
  const marketplace = JSON.parse(await fs.readFile(path.join(bundled, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.name), ["codex-app-tools", "browser"]);
  assert.deepEqual((await fs.readdir(path.join(bundled, "plugins"))).sort(), ["browser", "codex-app-tools"]);
  assert.deepEqual(await fs.readdir(path.join(root, "resources", "skills", "skills", ".curated")), ["keep-me"]);
});
