import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { requestAppearance, appearanceCommand } from "../src/sidebar-appearance-client.mjs";

async function fixture(t, handler = (request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ result: { ok: true } }));
}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "appearance-client-"));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const token = "a".repeat(64);
  await fs.writeFile(path.join(home, "appearance-endpoint.json"), JSON.stringify({ version: 1, port, token, pid: process.pid }));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, token, port };
}

test("client reads descriptor and sends bounded authorized local request", async t => {
  let received;
  const { home, token } = await fixture(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = { path: request.url, method: request.method, authorization: request.headers.authorization, body: JSON.parse(body) };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { items: ["a"] } }));
  });
  assert.deepEqual(await requestAppearance("list", { kind: "project" }, { home }), { items: ["a"] });
  assert.deepEqual(received, {
    path: "/appearance", method: "POST", authorization: `Bearer ${token}`,
    body: { operation: "list", args: { kind: "project" } },
  });
});

test("client rejects invalid descriptor, large request, redirect, and large response", async t => {
  const { home } = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: "https://example.com" });
    response.end();
  });
  await assert.rejects(requestAppearance("list", {}, { home }), /invalid/);
  await assert.rejects(requestAppearance("update", { drawing: "x".repeat(513 * 1024) }, { home }), /too large/);
  await fs.writeFile(path.join(home, "appearance-endpoint.json"), JSON.stringify({ version: 1, port: 80, token: "secret", pid: 1 }));
  await assert.rejects(requestAppearance("list", {}, { home }), /endpoint is invalid/);
  await fs.writeFile(path.join(home, "appearance-endpoint.json"), "x".repeat(4097));
  await assert.rejects(requestAppearance("list", {}, { home }), /endpoint is invalid/);
  const large = await fixture(t, (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: "x".repeat(1024 * 1024) }));
  });
  await assert.rejects(requestAppearance("list", {}, { home: large.home }), /too large/);
});

test("CLI parses list and explicit backfill options strictly", async t => {
  const calls = [];
  const { home } = await fixture(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    response.end(JSON.stringify({ result: { count: 2 } }));
  });
  const printed = [];
  await appearanceCommand(["list", "--threads"], { home, write: value => printed.push(value) });
  await appearanceCommand(["backfill", "--projects", "--model", "gpt-6-sol", "--replace", "--limit", "12"], { home, write: value => printed.push(value) });
  assert.deepEqual(calls, [
    { operation: "list", args: { kind: "thread" } },
    { operation: "backfill", args: { scope: "projects", model: "gpt-6-sol", replace: true, limit: 12 } },
  ]);
  assert.deepEqual(printed, ['{"count":2}', '{"count":2}']);
  await assert.rejects(appearanceCommand(["backfill", "--limit", "5"], { home }), /requires/);
  await assert.rejects(appearanceCommand(["list", "--all"], { home }), /supports/);
  await assert.rejects(appearanceCommand(["backfill", "--all", "--limit", "5001"], { home }), /Limit/);
  await assert.rejects(appearanceCommand(["list", "--threads", "--projects"], { home }), /scope/);
});

test("MCP stdio supports initialize, list, tool call, and invalid call without logging token", async t => {
  const { home, token } = await fixture(t);
  const script = path.resolve("bin/sidebar-appearance-mcp.mjs");
  const child = spawn(process.execPath, [script], {
    cwd: path.resolve("."), env: { ...process.env, CODEX_ZERO_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "appearance_list", arguments: { kind: "project" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "appearance_update", arguments: { kind: "project", id: "a", patch: { injected: true } } } },
  ];
  child.stdin.end(messages.map(message => JSON.stringify(message)).join("\n") + "\n");
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const output = Buffer.concat(stdout).toString();
  assert.equal(output.includes(token), false);
  assert.equal(Buffer.concat(stderr).toString().includes(token), false);
  const replies = output.trim().split("\n").map(JSON.parse);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(replies[2].result.tools.map(tool => tool.name), ["appearance_list", "appearance_update", "appearance_status", "appearance_backfill"]);
  assert.equal(replies[3].result.content[0].text, '{"ok":true}');
  assert.equal(replies[4].result.isError, true);
});

test("CLI targets one project, supports local only, and generate waits for completion",async t=>{
 const calls=[];const {home}=await fixture(t,async(request,response)=>{let body="";for await(const chunk of request)body+=chunk;const data=JSON.parse(body);calls.push(data);response.end(JSON.stringify({result:data.operation==="status"?{id:"0123456789abcdef",status:"complete",modelRequests:0}:{id:"0123456789abcdef",status:"running"}}));});
 const result=await appearanceCommand(["generate","--project","Example App","--local-only","--replace"],{home,write:()=>{}});
 assert.equal(result.status,"complete");assert.equal(result.modelRequests,0);
 assert.deepEqual(calls[0],{operation:"backfill",args:{scope:"projects",project:"Example App",replace:true,limit:5000,localOnly:true}});
 assert.equal(calls[1].operation,"status");
 await assert.rejects(appearanceCommand(["generate","--project","X","--local-only","--model","test"],{home}),/does not use/);
 await assert.rejects(appearanceCommand(["generate","--project"],{home}),/Project/);
});
