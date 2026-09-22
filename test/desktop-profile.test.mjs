import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { desktopProfileEnvironment } from "../src/desktop-profile.mjs";

test("Desktop reuses the existing Codex home without moving any user data", () => {
  const environment = Object.freeze({ PATH: "fixture", CODEX_HOME: "D:\\My Codex", CODEX_ZERO_HOME: "E:\\Zero" });
  assert.deepEqual(desktopProfileEnvironment({ environment, platform: "win32", home: "C:\\Users\\test" }), environment);
});

test("Desktop explicitly defaults to the stock Codex home", () => {
  assert.equal(desktopProfileEnvironment({ environment: {}, platform: "win32", home: "C:\\Users\\test" }).CODEX_HOME, "C:\\Users\\test\\.codex");
  assert.equal(desktopProfileEnvironment({ environment: {}, platform: "darwin", home: "/Users/test" }).CODEX_HOME, "/Users/test/.codex");
});

test("Desktop drops only an inherited CodexZero optimized SQLite override", () => {
  const environment = Object.freeze({ CODEX_HOME: "D:\\Codex", CODEX_SQLITE_HOME: "d:/codex/codexzero/sqlite/", CUSTOM: "preserved" });
  const result = desktopProfileEnvironment({ environment, platform: "win32" });
  assert.equal(result.CODEX_SQLITE_HOME, undefined);
  assert.equal(result.CUSTOM, "preserved");
  assert.equal(environment.CODEX_SQLITE_HOME, "d:/codex/codexzero/sqlite/");
});

test("Desktop honors unrelated explicit SQLite and CodexZero home overrides", () => {
  const environment = { CODEX_HOME: "D:\\Codex", CODEX_ZERO_HOME: "E:\\Zero", CODEX_SQLITE_HOME: "D:\\Chosen state" };
  assert.deepEqual(desktopProfileEnvironment({ environment, platform: "win32" }), environment);
  const inherited = { ...environment, CODEX_SQLITE_HOME: "E:\\Zero\\sqlite" };
  assert.equal(desktopProfileEnvironment({ environment: inherited, platform: "win32" }).CODEX_SQLITE_HOME, undefined);
  assert.equal(desktopProfileEnvironment({ environment: { ...inherited, CODEX_ZERO_SQLITE_HOME: "E:\\Custom", CODEX_SQLITE_HOME: "E:\\Custom" }, platform: "win32" }).CODEX_SQLITE_HOME, undefined);
});

test("Windows launcher retains the shared home and separate Chromium profile", async () => {
  const source = await fs.readFile(new URL("../scripts/build-codexzero-launcher.ps1", import.meta.url), "utf8");
  assert.match(source, /GetEnvironmentVariable\("CODEX_HOME"\)/);
  assert.match(source, /EnvironmentVariables\["CODEX_HOME"\] = codexHome/);
  assert.match(source, /EnvironmentVariables\["CODEX_ELECTRON_USER_DATA_PATH"\] = appData/);
  assert.match(source, /EnvironmentVariables\.Remove\("CODEX_SQLITE_HOME"\)/);
  assert.doesNotMatch(source, /File\.Copy|Directory\.Move|Directory\.Delete/);
});
