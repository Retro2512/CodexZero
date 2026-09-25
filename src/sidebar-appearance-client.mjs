import fs from "node:fs/promises";
import path from "node:path";
import { codexZeroHome } from "./paths.mjs";

const MAX_DESCRIPTOR = 4096;
const MAX_REQUEST = 512 * 1024;
const MAX_RESPONSE = 1024 * 1024;

function safeError(message) {
  if (typeof message !== "string") return "Appearance request failed";
  const clean = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean && clean.length <= 500 ? clean : "Appearance request failed";
}

async function descriptor(home) {
  const file = path.join(home, "appearance-endpoint.json");
  let content;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_DESCRIPTOR) throw new Error("Appearance endpoint is invalid");
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("CodexZero appearance service is not running");
    throw error;
  }
  if (Buffer.byteLength(content) > MAX_DESCRIPTOR) throw new Error("Appearance endpoint is invalid");
  let value;
  try { value = JSON.parse(content); } catch { throw new Error("Appearance endpoint is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
    !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    typeof value.token !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.token) ||
    !Number.isInteger(value.pid) || value.pid < 1) {
    throw new Error("Appearance endpoint is invalid");
  }
  if(process.env.CODEX_ZERO_APPEARANCE_BUILD){
    const expected=await fs.realpath(process.env.CODEX_ZERO_APPEARANCE_BUILD).catch(()=>null);
    const actual=typeof value.buildRoot==="string"?await fs.realpath(value.buildRoot).catch(()=>null):null;
    if(!expected||!actual||expected.toLowerCase()!==actual.toLowerCase())throw new Error("Open this preview before changing its appearance");
  }
  return value;
}

async function boundedResponse(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE) throw new Error("Appearance response is too large");
  const chunks = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE) {
      await response.body.cancel().catch(() => {});
      throw new Error("Appearance response is too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Appearance response is invalid"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Appearance response is invalid");
  return data;
}

export async function requestAppearance(operation, args = {}, { home = codexZeroHome(), timeoutMs = 120000 } = {}) {
  if (typeof operation !== "string" || !["list", "update", "backfill", "status"].includes(operation)) throw new TypeError("Appearance operation is invalid");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Appearance arguments are invalid");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new TypeError("Appearance timeout is invalid");
  const body = JSON.stringify({ operation, args });
  if (Buffer.byteLength(body) > MAX_REQUEST) throw new TypeError("Appearance request is too large");
  const endpoint = await descriptor(home);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${endpoint.port}/appearance`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("Appearance request timed out");
    throw new Error("CodexZero appearance service is unavailable");
  }
  const data = await boundedResponse(response);
  if (response.status < 200 || response.status >= 300 || Object.hasOwn(data, "error")) {
    throw new Error(safeError(data.error));
  }
  if (!Object.hasOwn(data, "result")) throw new Error("Appearance response is invalid");
  return data.result;
}

function parseInteger(raw, label, min, max) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new TypeError(`${label} is invalid`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${label} is invalid`);
  return value;
}

export async function appearanceCommand(args, { write = console.log, home } = {}) {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) throw new TypeError("Appearance arguments are invalid");
  const [command, ...flags] = args;
  if (command === "status" && flags.length === 1 && /^[a-f0-9]{16}$/.test(flags[0])) {
    const result = await requestAppearance("status", { id: flags[0] }, { home });
    write(JSON.stringify(result)); return result;
  }
  if (!["list","backfill","generate"].includes(command)) throw new TypeError("Expected appearance list, generate, backfill or status");
  let scope,model,project,hostId;
  let replace=false,localOnly=false,wait=command==="generate",limit=5000;
  const seen=new Set();
  const value=(index,label,max=4096)=>{const raw=flags[index];if(typeof raw!=="string"||!raw||raw.startsWith("--")||raw.length>max)throw new TypeError(`${label} is invalid`);return raw;};
  for(let i=0;i<flags.length;i++){
    const flag=flags[i];if(seen.has(flag))throw new TypeError(`Duplicate option: ${flag}`);seen.add(flag);
    if(["--projects","--threads","--all"].includes(flag)){if(scope)throw new TypeError("Select one appearance scope");scope=flag.slice(2);}
    else if(command!=="list"&&flag==="--project")project=value(++i,"Project");
    else if(command!=="list"&&flag==="--host")hostId=value(++i,"Host",512);
    else if(command!=="list"&&flag==="--replace")replace=true;
    else if(command!=="list"&&flag==="--local-only")localOnly=true;
    else if(command!=="list"&&flag==="--wait")wait=true;
    else if(command!=="list"&&flag==="--model")model=value(++i,"Model",256);
    else if(command!=="list"&&flag==="--limit")limit=parseInteger(flags[++i],"Limit",1,5000);
    else throw new TypeError(`Unknown appearance option: ${flag}`);
  }
  if(command==="list"){
    if(scope==="all")throw new TypeError("List supports projects or threads");
    const result=await requestAppearance("list",scope?{kind:scope==="projects"?"project":"thread"}:{},{home});write(JSON.stringify(result));return result;
  }
  if(project&&!scope)scope="projects";
  if(!scope)throw new TypeError("Backfill requires a project, projects, threads, or all");
  if(localOnly&&model)throw new TypeError("Local only does not use a model");
  let result=await requestAppearance("backfill",{scope,...(project?{project}:{}),...(hostId?{hostId}:{}),...(model?{model}:{}),replace,limit,...(localOnly?{localOnly:true}:{})},{home});
  const deadline=Date.now()+600000;
  while(wait&&result?.status==="running"&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1000));result=await requestAppearance("status",{id:result.id},{home});}
  write(JSON.stringify(result));return result;
}
