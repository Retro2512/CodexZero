import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { providerCoreEnvironment } from "../src/provider-app-server.mjs";

test("packaged desktop core isolates only its database while retaining shared sessions", () => {
  const environment = { CODEX_HOME: "shared-home", CODEX_ZERO_HOME: "zero-home", CODEX_SQLITE_HOME: "stock-index", EXISTING: "value" };
  const selected = providerCoreEnvironment("codex-zero-core.exe", { environment });
  assert.equal(selected.CODEX_SQLITE_HOME, path.join("zero-home", "desktop-sqlite"));
  assert.equal(selected.CODEX_HOME, "shared-home");
  assert.equal(selected.EXISTING, "value");
  assert.equal(environment.CODEX_SQLITE_HOME, "stock-index");
  assert.equal(providerCoreEnvironment("codex.exe", { environment }), environment);
  assert.equal(providerCoreEnvironment("codex-zero-core", { environment, home: "custom-zero" }).CODEX_SQLITE_HOME,
    path.join("custom-zero", "desktop-sqlite"));
});
