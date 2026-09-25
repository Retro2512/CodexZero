"use strict";
const { app, ipcMain, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = process.platform === "darwin" ? path.join(process.resourcesPath,"codexzero") : path.resolve(process.resourcesPath,"..","..");
let instance;
function service() {
  return instance ??= import(pathToFileURL(path.join(root,"src","sidebar-appearance-service.mjs")).href).then(({AppearanceService})=>{
    const service=new AppearanceService({notify:event=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send("codexzero:appearance:changed",event);}});
    void service.listen().catch(()=>{});
    app.once("before-quit",()=>{void service.close();});return service;
  });
}
function trusted(event) {
  if(!event.senderFrame||event.senderFrame!==event.sender.mainFrame)return false;
  try{const url=new URL(event.senderFrame.url);return url.protocol==="app:"&&url.hostname==="-";}catch{return false;}
}
for(const operation of ["snapshot","observe","update"]){
  ipcMain.handle(`codexzero:appearance:${operation}`,async(event,args)=>{
    if(!trusted(event))throw new Error("Appearance unavailable");
    if(Buffer.byteLength(JSON.stringify(args??null))>512*1024)throw new TypeError("Request too large");
    try{return await (await service()).operation(operation,args);}catch(e){throw new Error(e instanceof TypeError?e.message:"Could not update appearance");}
  });
}
exports.register=(client,generate,params)=>{void service().then(s=>s.registerClient(client,generate,params)).catch(()=>{});};
exports.created=(client,result,params)=>{if(params?.ephemeral||!result?.thread?.id)return;void service().then(s=>s.observe([{kind:"thread",id:result.thread.id,hostId:client.options?.hostId??"local",title:result.thread.name??result.thread.title??"",cwd:result.thread.cwd??params.cwd,projectId:result.thread.projectId}])).catch(()=>{});};
exports.prepare=async(client,threadId,cwd)=>{try{return await(await service()).titleContext(client,threadId,cwd,{allowRead:false});}catch{return null;}};
exports.accept=(context,result)=>{void service().then(s=>s.accept(context,result)).catch(()=>{});};
exports.titleUpdated=(client,threadId,title)=>{void service().then(s=>s.titleUpdated(client,threadId,title)).catch(()=>{});};
