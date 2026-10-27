const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mediaCatch', {
  command: (name, arg) => ipcRenderer.invoke('capture:command', name, arg),
  preview: id => ipcRenderer.invoke('capture:preview', id),
  onPreviewProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('capture:preview-progress', listener);
    return () => ipcRenderer.removeListener('capture:preview-progress', listener);
  },
  bounds: rect => ipcRenderer.send('capture:bounds', rect),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('capture:state', listener);
    return () => ipcRenderer.removeListener('capture:state', listener);
  },
});
