import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const mode = process.argv[2];

try {
  if (mode === "desktop") {
    const application = path.join(root, "CodexZero.exe");
    await fs.access(application);
    const child = spawn(application, [], {
      detached: true, windowsHide: false, stdio: "ignore",
      env: process.env
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    console.log("CodexZero started.");
  } else {
    throw new Error("Open CodexZero, then Settings > Agent > Custom models.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
