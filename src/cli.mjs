import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { aggregateSavings, formatSavings, readTelemetry } from "./savings.mjs";
import { artifactRoot, codexHome, codexZeroHome, statePath, telemetryPath } from "./paths.mjs";
import { runChecks } from "./run-checks.mjs";

export async function main(args) {
  const [command = "help", ...rest] = args;
  if (command === "savings") return savings(rest);
  if (command === "monitor") return monitor(rest);
  if (command === "doctor") return doctor();
  if (command === "run-checks") return checks(rest);
  if (command === "run") return launch(rest, false);
  if (command === "stock") return launch(rest, true);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(help());
    return;
  }
  throw new Error(`Unknown command "${command}". Run codex-zero help.`);
}

async function savings(args) {
  const summary = aggregateSavings(await readTelemetry());
  if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
  else console.log(formatSavings(summary));
}

async function monitor(args) {
  const pidPath = path.join(codexZeroHome(), "monitor.pid");
  if (args.includes("--start")) {
    await fs.mkdir(codexZeroHome(), { recursive: true });
    const existing = await readPid(pidPath);
    if (existing && processExists(existing)) {
      console.log(`Savings monitor is already running (PID ${existing}).`);
      return;
    }
    const entrypoint = path.resolve(import.meta.dirname, "..", "bin", "codex-zero.mjs");
    const child = spawn(process.execPath, [entrypoint, "monitor", "--service"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env
    });
    child.unref();
    await fs.writeFile(pidPath, `${child.pid}\n`);
    console.log(`Savings monitor started (PID ${child.pid}).`);
    return;
  }
  if (args.includes("--stop")) {
    const pid = await readPid(pidPath);
    if (!pid || !processExists(pid)) {
      console.log("Savings monitor is not running.");
      await fs.rm(pidPath, { force: true });
      return;
    }
    process.kill(pid);
    await fs.rm(pidPath, { force: true });
    console.log("Savings monitor stopped.");
    return;
  }
  if (args.includes("--status")) {
    const pid = await readPid(pidPath);
    console.log(pid && processExists(pid)
      ? `Savings monitor is running (PID ${pid}).`
      : "Savings monitor is not running.");
    return;
  }
  const once = args.includes("--once");
  const service = args.includes("--service");
  const intervalArgument = args.find((item) => item.startsWith("--interval="));
  const intervalMs = intervalArgument ? Number(intervalArgument.split("=")[1]) : 5000;
  if (!Number.isFinite(intervalMs) || intervalMs < 250) {
    throw new Error("Monitor interval must be at least 250 ms");
  }
  await persistSavings();
  if (once) return;
  if (!service) {
    console.log(`Monitoring ${telemetryPath()}`);
    console.log("Press Ctrl+C to stop.");
  }
  await fs.mkdir(path.dirname(telemetryPath()), { recursive: true });
  let timer;
  fsSync.watch(path.dirname(telemetryPath()), (_event, filename) => {
    if (filename && filename.toString() !== path.basename(telemetryPath())) return;
    clearTimeout(timer);
    timer = setTimeout(() => void persistSavings(), intervalMs);
  });
  await new Promise(() => {});
}

async function readPid(file) {
  try {
    const value = Number.parseInt(await fs.readFile(file, "utf8"), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function persistSavings() {
  const summary = aggregateSavings(await readTelemetry());
  const destination = statePath();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.rename(temporary, destination);
}

async function doctor() {
  const home = codexHome();
  const customBinary = customBinaryPath();
  const checks = [
    ["Codex home", home, await exists(home)],
    ["Config", path.join(home, "config.toml"), await exists(path.join(home, "config.toml"))],
    ["Custom binary", customBinary, await exists(customBinary)],
    ["Artifact store", artifactRoot(), true],
    ["Telemetry", telemetryPath(), true]
  ];
  for (const [label, value, ok] of checks) {
    console.log(`${ok ? "✓" : "×"} ${label}: ${value}`);
  }
  if (!checks[2][2]) process.exitCode = 2;
}

async function checks(args) {
  const profile = args.find((item) => !item.startsWith("-"));
  if (!profile) throw new Error("Usage: codex-zero run-checks <profile>");
  const result = await runChecks(profile, {
    onProgress: ({ current, total, command }) => {
      console.error(`[${current}/${total}] ${command}`);
    }
  });
  console.log(JSON.stringify(result));
  if (!result.success) process.exitCode = 1;
}

async function launch(args, stock) {
  const executable = stock ? await stockBinaryPath() : customBinaryPath();
  if (!stock && !(await exists(executable))) {
    throw new Error(`Custom binary not found at ${executable}. Run the installer or use "codex-zero stock".`);
  }
  const launchArguments = stock
    ? args
    : [
        "--profile",
        "codexzero",
        "-c",
        "background_terminal_max_timeout=3600000",
        "-c",
        "features.unified_exec=true",
        "-c",
        "features.codex_zero_compact_exec_output=true",
        "-c",
        "features.codex_zero_lossless_terminal_codec=true",
        "-c",
        "features.codex_zero_exact_duplicate_results=true",
        ...args
      ];
  const child = spawn(executable, launchArguments, {
    stdio: "inherit",
    env: {
      ...process.env,
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GH_PAGER: "cat",
      CODEX_ZERO_HOME: codexZeroHome(),
      CODEX_ZERO_ARTIFACT_DIR: artifactRoot(),
      CODEX_ZERO_TELEMETRY_FILE: telemetryPath()
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

function customBinaryPath() {
  const name = process.platform === "win32" ? "codex-zero-core.exe" : "codex-zero-core";
  return process.env.CODEX_ZERO_BINARY || path.join(codexZeroHome(), "bin", name);
}

async function stockBinaryPath() {
  if (process.env.CODEX_STOCK_BINARY) return process.env.CODEX_STOCK_BINARY;
  if (process.platform !== "win32") return "codex";

  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const candidate = path.join(
    process.env.APPDATA || path.join(path.dirname(codexHome()), "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    `codex-win32-${architecture}`,
    "vendor",
    `${architecture === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`,
    "bin",
    "codex.exe"
  );
  return await exists(candidate) ? candidate : "codex.exe";
}

async function exists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function help() {
  return [
    "CodexZero — zero wasted turns",
    "",
    "codex-zero run [codex arguments]    Run the side-by-side optimized CLI",
    "codex-zero stock [codex arguments]  Run the untouched stock CLI",
    "codex-zero savings [--json]         Show measured savings",
    "codex-zero monitor --start|--stop   Manage the savings monitor service",
    "codex-zero monitor --status         Show monitor service status",
    "codex-zero run-checks <profile>     Run a deterministic local check batch",
    "codex-zero doctor                   Verify the installation"
  ].join("\n");
}
