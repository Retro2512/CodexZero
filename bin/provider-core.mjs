import { spawn } from "node:child_process";
import { runProviderAppServer } from "../src/provider-app-server.mjs";

const core = process.env.CODEX_ZERO_PROVIDER_CORE;
if (!core) throw new Error("Launch custom models through CodexZero");
const args = process.argv.slice(2);
const index = args.indexOf("app-server");
// Help, schema generation and non server invocations keep the real CLI behavior.
const serving = index >= 0 && !args.some(arg => ["--help", "-h", "generate-ts", "generate-json-schema", "daemon", "proxy"].includes(arg));
if (serving) {
  const listenIndex = args.indexOf("--listen");
  if (listenIndex >= 0 && args[listenIndex + 1] !== "stdio://") {
    throw new Error("Custom models require the stdio app server transport");
  }
  process.exitCode = await runProviderAppServer({ core, args });
} else {
  const child = spawn(core, args, { stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => { child.once("exit", code => resolve(code ?? 1)); child.once("error", reject); });
}
