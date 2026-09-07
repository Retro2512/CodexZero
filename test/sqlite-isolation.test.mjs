import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildLaunchEnvironment } from "../src/cli.mjs";
import { codexZeroHome, sqliteRoot } from "../src/paths.mjs";

test("CodexZero SQLite state is isolated from the stock Codex home", () => {
  const environment = { CODEX_HOME: path.join("C:", "Users", "test", ".codex") };

  assert.equal(
    sqliteRoot(environment),
    path.join(codexZeroHome(environment), "sqlite")
  );
  assert.notEqual(sqliteRoot(environment), environment.CODEX_HOME);
});

test("the isolated SQLite location can be overridden", () => {
  const environment = {
    CODEX_HOME: path.join("C:", "Users", "test", ".codex"),
    CODEX_ZERO_SQLITE_HOME: path.join("D:", "codex-zero-state")
  };

  assert.equal(sqliteRoot(environment), environment.CODEX_ZERO_SQLITE_HOME);
});

test("optimized launches pass the isolated SQLite home", () => {
  const environment = { CODEX_HOME: path.join("C:", "Users", "test", ".codex") };
  const launchEnvironment = buildLaunchEnvironment({ environment });

  assert.equal(launchEnvironment.CODEX_SQLITE_HOME, sqliteRoot(environment));
});

test("stock launches do not opt into CodexZero's SQLite directory", () => {
  const environment = { CODEX_HOME: path.join("C:", "Users", "test", ".codex") };
  const launchEnvironment = buildLaunchEnvironment({
    environment,
    optimized: false
  });

  assert.equal("CODEX_SQLITE_HOME" in launchEnvironment, false);
});

test("stock launches preserve the exact caller environment", () => {
  const environment = { TERM: "xterm-256color", PAGER: "less", NO_COLOR: "0", CUSTOM: "value" };
  assert.deepEqual(buildLaunchEnvironment({ environment, optimized: false }), environment);
});
