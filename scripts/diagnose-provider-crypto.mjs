import { spawnSync } from "node:child_process";
import path from "node:path";
const root = process.env.SystemRoot;
const exe = path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe");
const minimal = { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP };
const safe = { ...minimal };
for (const key of ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "COMSPEC", "PATHEXT"])
  if (process.env[key]) safe[key] = process.env[key];
safe.PATH = `${root}\\System32;${root};${root}\\System32\\WindowsPowerShell\\v1.0`;
safe.PSModulePath = `${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`;
const full = { ...process.env, PSModulePath: safe.PSModulePath };
const measure = (label, script, env) => {
  const start = Date.now();
  const result = spawnSync(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env, encoding: "utf8", windowsHide: true, timeout: 90000,
  });
  console.log(JSON.stringify({ label, ms: Date.now() - start, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }));
  if (result.status !== 0) process.exitCode = 1;
};
const crypto = "$ErrorActionPreference='Stop';$s=[Diagnostics.Stopwatch]::StartNew();$bytes=[Text.Encoding]::UTF8.GetBytes('diagnostic-only');$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);if([Text.Encoding]::UTF8.GetString($plain) -ne 'diagnostic-only'){throw 'Round trip mismatch'};Write-Output ('crypto_ms='+$s.ElapsedMilliseconds)";
const addType = "$s=[Diagnostics.Stopwatch]::StartNew();Add-Type -AssemblyName System.Security;Write-Output ('load_ms='+$s.ElapsedMilliseconds);";
const reflection = "$s=[Diagnostics.Stopwatch]::StartNew();[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');Write-Output ('load_ms='+$s.ElapsedMilliseconds);";
measure("minimal startup", "Write-Output ready", minimal);
measure("minimal Add-Type", addType + crypto, minimal);
measure("safe Add-Type", addType + crypto, safe);
measure("full Add-Type", addType + crypto, full);
measure("safe assembly load", reflection + crypto, safe);
