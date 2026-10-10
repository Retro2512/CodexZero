import { spawn } from "node:child_process";
import { runProviderAppServer } from "../src/provider-app-server.mjs";
import { selectUpdatedCore, launchCoreUpdateWorker, isPackagedPatchedCore } from "../src/core-updates.mjs";

const core = process.env.CODEX_ZERO_PROVIDER_CORE;
if (!core) throw new Error("Launch custom models through CodexZero");
const args = process.argv.slice(2);
const packaged = isPackagedPatchedCore(core);
const index = args.indexOf("app-server");
// Help, schema generation and non server invocations keep the real CLI behavior.
const serving = index >= 0 && !args.some(arg => ["--help", "-h", "generate-ts", "generate-json-schema", "daemon", "proxy"].includes(arg));
if (serving) {
  const listenIndex = args.indexOf("--listen");
  if (listenIndex >= 0 && args[listenIndex + 1] !== "stdio://") {
    throw new Error("Custom models require the stdio app server transport");
  }
  const selectedCore = packaged ? core : selectUpdatedCore(core);
  // The app starts immediately using its already verified runtime. Discovery,
  // copying and offline qualification happen in another process after startup.
  const check = () => { if (packaged) return; try { launchCoreUpdateWorker(core); } catch { /* Keep the current runtime. */ } };
  const firstCheck = setTimeout(check, 30_000);
  // Allow for the first worker's startup delay before its 30 minute throttle.
  const periodicCheck = setInterval(check, 31 * 60_000);
  firstCheck.unref(); periodicCheck.unref();
  try { process.exitCode = await runProviderAppServer({ core: selectedCore, args }); }
  finally { clearTimeout(firstCheck); clearInterval(periodicCheck); }
} else {
  const child = spawn(packaged ? core : selectUpdatedCore(core), args, { stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => { child.once("exit", code => resolve(code ?? 1)); child.once("error", reject); });
}
