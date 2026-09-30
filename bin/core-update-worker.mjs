import { checkForCoreUpdate } from "../src/core-updates.mjs";
import { verifyCoreCompatibility } from "../src/core-compatibility.mjs";
import os from "node:os";

const fallback = process.argv[2];
if (fallback) {
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const timer = setTimeout(() => process.exit(1), 900_000);
  timer.unref();
  try { await checkForCoreUpdate(fallback, { releaseId: process.argv[3], verifyCoreCompatibility }); }
  finally { clearTimeout(timer); }
}
