'use strict';
// The bridge: the page gets exactly these functions as window.invoiceApp — nothing else from Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('invoiceApp', {
  load: () => ipcRenderer.invoke('data:load'),
  save: text => ipcRenderer.send('data:save', text),
  onSaveError: cb => ipcRenderer.on('data:save-error', (_e, msg) => cb(msg)),
  savePdf: (month, fileName) => ipcRenderer.invoke('pdf:save', { month, fileName }),
  openPath: p => ipcRenderer.invoke('shell:open', p),
  showInFolder: p => ipcRenderer.invoke('shell:show', p),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  exportBackup: text => ipcRenderer.invoke('backup:export', text),
  importBackup: () => ipcRenderer.invoke('backup:import'),
});
