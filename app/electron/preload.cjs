// Minimal, explicit bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('stemdeck', {
  engineState: () => ipcRenderer.invoke('engine:state'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  onEngineState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('engine:state', handler);
    return () => ipcRenderer.removeListener('engine:state', handler);
  },
  openFiles: (opts) => ipcRenderer.invoke('dialog:openFiles', opts),
  openFolder: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  openJson: () => ipcRenderer.invoke('dialog:openJson'),
  saveJson: (name, content) => ipcRenderer.invoke('dialog:saveJson', name, content),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
});
