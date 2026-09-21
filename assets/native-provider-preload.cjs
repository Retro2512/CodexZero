;(() => {
  const { contextBridge, ipcRenderer } = require("electron");
  if (location.protocol !== "app:" || location.hostname !== "-") return;
  contextBridge.exposeInMainWorld("codexZeroProviders", {
    read: () => ipcRenderer.invoke("codexzero:providers:read"),
    save: document => ipcRenderer.invoke("codexzero:providers:save", document)
  });
  contextBridge.exposeInMainWorld("codexZeroCache", {
    read: threadId => ipcRenderer.invoke("codexzero:cache:read", threadId),
    saveSettings: settings => ipcRenderer.invoke("codexzero:cache:settings", settings),
    setEnabled: (threadId, enabled) => ipcRenderer.invoke("codexzero:cache:enabled", threadId, enabled),
    activity: threadId => ipcRenderer.invoke("codexzero:cache:activity", threadId)
  });
})();
