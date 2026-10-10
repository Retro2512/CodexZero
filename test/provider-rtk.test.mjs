import assert from "node:assert/strict";
import test from "node:test";
import { discovery, rtkEnvironment, rtkGuidance } from "../src/provider-rtk.mjs";

test("RTK discovery uses absolute PATH entries without running commands", () => {
  const inspected = [];
  const runtime = discovery({
    environment: { Path: 'relative;"C:\\Program Files\\Tools";C:\\Other' },
    platform: "win32",
    isExecutable(file) { inspected.push(file); return file === "C:\\Program Files\\Tools\\rtk.exe"; },
  });
  assert.deepEqual(inspected, ["C:\\Program Files\\Tools\\rtk.exe"]);
  assert.deepEqual(runtime, {
    available: true, executable: "C:\\Program Files\\Tools\\rtk.exe", pathKey: "Path", platform: "win32",
  });
  const guidance = rtkGuidance(runtime);
  for (const phrase of ["git", "npm", "package managers", "builds", "linters", "tests", "rtk grep", "PowerShell cmdlets", "shell builtins", "exact output", "rtk proxy", "Batch related read only inspections", "cap output"]) {
    assert.ok(guidance.includes(phrase), phrase);
  }
});

test("missing RTK leaves guidance and environment unchanged", () => {
  const env = { PATH: "/usr/bin:/opt/bin" };
  const runtime = discovery({ environment: env, platform: "linux", isExecutable: () => false });
  assert.equal(runtime.available, false);
  assert.equal(rtkGuidance(runtime), "");
  assert.equal(rtkEnvironment(env, runtime), env);
});

test("RTK directory is retained without changing other child variables", () => {
  const env = { Path: "C:\\Other", TOKEN: "opaque" };
  const runtime = { available: true, executable: "C:\\Tools\\rtk.exe", platform: "win32" };
  assert.deepEqual(rtkEnvironment(env, runtime), { Path: "C:\\Tools;C:\\Other", TOKEN: "opaque" });
  const alreadyPresent = { Path: "c:\\tools;C:\\Other" };
  assert.equal(rtkEnvironment(alreadyPresent, runtime), alreadyPresent);
});

