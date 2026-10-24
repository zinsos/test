import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("snypra", {
  action: (name: string): void => {
    ipcRenderer.send("snypra:action", String(name));
  },
  getStatus: (): Promise<unknown> => ipcRenderer.invoke("snypra:get-status"),
  getSetup: (): Promise<unknown> => ipcRenderer.invoke("snypra:get-setup"),
  saveSetup: (url: string, token: string): Promise<unknown> => ipcRenderer.invoke("snypra:save-setup", String(url), String(token)),
  onStatus: (listener: (status: unknown) => void): void => {
    ipcRenderer.on("snypra:status", (_event, status: unknown) => listener(status));
  }
});
