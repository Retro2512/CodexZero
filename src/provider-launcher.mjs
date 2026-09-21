import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexZeroHome } from "./paths.mjs";

const execFileAsync = promisify(execFile);

export async function prepareProviderLauncher(desktopBinary, { home = codexZeroHome() } = {}) {
  const root = path.join(home, "provider-runtime");
  await fs.mkdir(root, { recursive: true });
  const entry = path.resolve(import.meta.dirname, "..", "bin", "provider-core.mjs");
  let core = process.env.CODEX_ZERO_PROVIDER_CORE;
  if (!core) {
    const resources = process.platform === "win32"
      ? path.join(path.dirname(desktopBinary), "resources")
      : path.resolve(path.dirname(desktopBinary), "..", "Resources");
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    // A versioned copy can execute outside the Windows packaged app container.
    const version = (await fs.stat(path.join(resources, name))).mtimeMs.toString().replace(".", "_");
    const versionRoot = path.join(root, version);
    await fs.mkdir(versionRoot, { recursive: true });
    core = path.join(versionRoot, name);
    const companions = process.platform === "win32"
      ? [name, "codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "codex-windows-sandbox-service.exe", "rg.exe"]
      : [name, "codex-code-mode-host", "rg"];
    for (const file of companions) {
      const source = path.join(resources, file);
      const dest = path.join(versionRoot, file);
      try { await fs.access(dest); } catch {
        try { await fs.copyFile(source, dest); } catch (error) { if (file === name || error.code !== "ENOENT") throw error; }
      }
    }
  }
  let launcher;
  if (process.platform === "win32") {
    launcher = path.join(root, "codex-custom-models.exe");
    const source = path.join(root, "launcher.cs");
    const quote = value => `@"${value.replaceAll('"', '""')}"`;
    await fs.writeFile(source, `using System; using System.Diagnostics; using System.Text;
class Launcher {
static System.Threading.Thread Pump(System.IO.Stream input, System.IO.Stream output, bool closeOutput) {
  var thread = new System.Threading.Thread(() => {
    try { var buffer = new byte[8192]; int length; while ((length = input.Read(buffer, 0, buffer.Length)) > 0) { output.Write(buffer, 0, length); output.Flush(); } }
    catch (System.IO.IOException) {} catch (ObjectDisposedException) {}
    finally { if (closeOutput) { try { output.Close(); } catch {} } }
  });
  thread.IsBackground = true; thread.Start(); return thread;
}
static string Q(string s) {
  var b = new StringBuilder(); b.Append((char)34); int slashes = 0;
  foreach (char c in s) {
    if (c == (char)92) { slashes++; continue; }
    if (c == (char)34) { b.Append((char)92, slashes * 2 + 1); b.Append(c); }
    else { b.Append((char)92, slashes); b.Append(c); }
    slashes = 0;
  }
  b.Append((char)92, slashes * 2); b.Append((char)34); return b.ToString();
}
static int Main(string[] args) {
  var p = new ProcessStartInfo(); p.FileName = ${quote(process.execPath)}; p.Arguments = Q(${quote(entry)});
  foreach (var a in args) p.Arguments += " " + Q(a);
  p.UseShellExecute = false; p.CreateNoWindow = true;
  p.RedirectStandardInput = true; p.RedirectStandardOutput = true; p.RedirectStandardError = true;
  using (var child = Process.Start(p)) {
    Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
    var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
    var error = Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false);
    child.WaitForExit(); output.Join(); error.Join(); return child.ExitCode;
  }
}
}`);
    const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${launcher}`, source], { windowsHide: true });
  } else {
    launcher = path.join(root, "codex-custom-models");
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, { mode: 0o700 });
  }
  return { launcher, core };
}

export async function launchProviderDesktop(desktopBinary) {
  const { prepareNativeProviderDesktop } = await import("./native-provider-build.mjs");
  const { application, launcher, core } = await prepareNativeProviderDesktop(desktopBinary);
  const child = spawn(application, [], {
    detached: true, stdio: "ignore", windowsHide: false,
    env: { ...process.env, CODEX_CLI_PATH: launcher, CODEX_APP_SERVER_FORCE_CLI: "1", CODEX_ZERO_PROVIDER_CORE: core }
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
