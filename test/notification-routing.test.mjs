import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import routing from "../assets/native-notification-routing.cjs";
import { patchNotificationBootstrap, patchNotificationMain } from "../src/notification-routing-patch.mjs";

const link = route => `codexzero://notification?${new URLSearchParams({ path: route })}`;

test("notification routes preserve local, remote and host paths without opening arbitrary URLs", () => {
  for (const route of ["/local/abc", "/local/abc?hostId=worker%20pc", "/remote/abc"]) {
    assert.deepEqual(routing.notificationRoute(link(route)), { kind: "codexZeroNotification", path: route });
  }
  for (const route of ["https://example.com", "//example.com", "/settings", "/local/abc#x", "/local/abc\n", "/local/a\\b"]) {
    assert.equal(routing.notificationRoute(link(route)), null);
  }
  for (const url of ["invalid", "codex://threads/abc", link("/local/abc") + "&path=/local/def", "codexzero://user@notification?path=/local/abc", "codexzero://notification/extra?path=/local/abc"]) {
    assert.equal(routing.notificationRoute(url), null);
  }
});

test("Windows notification body activates its task and retains native action payloads", () => {
  class Notification { constructor(options) { this.options = options; this.id = "toast123"; } }
  const options = { title: 'A < B & "C"', body: "Done\u0000", hasReply: true, replyPlaceholder: "Reply", timeoutType: "never", actions: [{ type: "button", text: "Allow & continue" }], codexZeroNavigationPath: "/local/abc?hostId=worker" };
  const result = routing.createNotification(Notification, options, "win32");
  assert.equal(result.options.codexZeroNavigationPath, undefined);
  assert.match(result.toastXml, /activationType="protocol"/);
  assert.match(result.toastXml, /scenario="reminder"/);
  assert.match(result.toastXml, /A &lt; B &amp; &quot;C&quot;/);
  assert.match(result.toastXml, /type=action&amp;action=0&amp;tag=toast123/);
  assert.match(result.toastXml, /type=reply&amp;tag=toast123/);
  assert.match(result.toastXml, /Allow &amp; continue/);
  assert.doesNotMatch(result.toastXml, /\u0000/);
  const launch = result.toastXml.match(/launch="([^"]+)"/)[1].replaceAll("&amp;", "&");
  assert.equal(routing.notificationRoute(launch).path, options.codexZeroNavigationPath);
  assert.equal(routing.createNotification(Notification, options, "darwin").toastXml, undefined);
  assert.equal(routing.createNotification(Notification, { title: "No task" }, "win32").toastXml, undefined);
});

const mainFixture = 'let en={Notification:class{constructor(o){this.options=o;this.id="toast1"}}};function Manager(e){this.notifications=new Map;this.removed=0;this.removeNotification=()=>this.removed++;this.createNotification=e.createNotification??(e=>new en.Notification(e))}function show(e){let s=this.createNotification({title:f,body:e.body});return s}function listen(e,s){this.notifications.set(e.id,{notification:s});s.on("close",()=>{this.notifications.get(e.id)?.notification===s&&this.removeNotification(e.id)})}async function navigate(e,t,l){switch(t.kind){case"localConversation":{return}}}var f="Title";';

test("patched native route uses existing navigation and retains callbacks after banner timeout", async () => {
  const calls = [];
  const context = { process: { platform: "win32" }, require: () => routing };
  vm.runInNewContext(patchNotificationMain(mainFixture), context);
  await context.navigate("window", routing.notificationRoute(link("/local/abc?hostId=worker")), (...args) => calls.push(args));
  assert.deepEqual(calls, [["window", "/local/abc?hostId=worker"]]);
  const manager = new context.Manager({});
  const shown = context.show.call(manager, { body: "Done", navigationPath: "/local/abc" });
  assert.equal(shown.options.codexZeroNavigationPath, undefined);
  if (process.platform === "win32") assert.match(shown.toastXml, /activationType="protocol"/);
  const notification = new EventEmitter();
  context.listen.call(manager, { id: "n" }, notification);
  notification.emit("close", { reason: "timedOut" });
  notification.emit("close", {});
  assert.equal(manager.removed, 0);
  notification.emit("close", { reason: "userCanceled" });
  assert.equal(manager.removed, 1);
  context.process.platform = "darwin";
  notification.emit("close", {});
  assert.equal(manager.removed, 2);
});

test("bootstrap accepts task links on startup and reuse, failing closed when upstream changes", () => {
  const context = { require: () => routing, URL };
  vm.runInNewContext(patchNotificationBootstrap('function j(e){let t;try{t=new URL(e)}catch{return null}if("https:"===t.protocol){return null}return null}'), context);
  assert.equal(context.j(link("/remote/abc")).path, "/remote/abc");
  assert.equal(context.j("not a link"), null);
  for (const patch of [patchNotificationMain, patchNotificationBootstrap]) {
    assert.throws(() => patch("changed upstream"), /updated notification routing patch/);
  }
  assert.throws(() => patchNotificationMain(mainFixture + mainFixture), /updated notification routing patch/);
});

test("compiled Windows launcher preserves activation arguments through updates", { skip: process.platform !== "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-notification-launch-"));
  // The captured file can arrive just before Windows releases the fixture exe.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
  const run = promisify(execFile);
  const desktop = path.join(root, "desktop.exe");
  const capture = path.join(root, "capture.cs");
  await fs.writeFile(capture, 'using System;using System.IO;using System.Text;class Capture{static void Main(string[] args){File.WriteAllLines(Environment.GetEnvironmentVariable("CZ_CAPTURE"),Array.ConvertAll(args,s=>Convert.ToBase64String(Encoding.UTF8.GetBytes(s))));}}');
  await run(path.join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", `/out:${desktop}`, capture], { windowsHide: true });
  await fs.writeFile(path.join(root, "local-build.json"), JSON.stringify({ desktopBinary: desktop, core: "core.exe", launcher: "cli.exe" }));
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("scripts/build-codexzero-launcher.ps1"), "-BuildRoot", root, "-IconPath", path.resolve("assets/codexzero.ico")], { windowsHide: true });
  const args = [link("/local/abc?hostId=worker%20pc"), 'spaces and "quotes"', "trailing\\", ""];
  async function check(name) {
    const output = path.join(root, name);
    await run(path.join(root, "CodexZero.exe"), args, { env: { ...process.env, CZ_CAPTURE: output }, windowsHide: true });
    const deadline = Date.now() + 10000;
    let contents;
    while (Date.now() < deadline) {
      contents = await fs.readFile(output, "utf8").catch(() => null);
      if (contents !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.notEqual(contents, null, "launched desktop did not capture arguments");
    const received = contents.replace(/\r?\n$/, "").split(/\r?\n/).map(s => Buffer.from(s, "base64").toString());
    assert.match(received[0], /^--user-data-dir=/);
    assert.deepEqual(received.slice(1), args);
  }
  await check("direct.txt");
  const update = path.join(root, "updates", "next");
  await fs.mkdir(update, { recursive: true });
  for (const name of ["CodexZero.exe", "desktop.exe"]) await fs.copyFile(path.join(root, name), path.join(update, name));
  await fs.writeFile(path.join(root, "current-build.txt"), "updates\\next");
  await check("updated.txt");
});
