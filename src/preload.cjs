const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petlink', {
  call: async (channel, value) => {
    if (!['get-state', 'configure', 'copy-invite', 'send', 'open', 'dismiss', 'mute', 'link', 'save-attachment', 'reset', 'bubble-height'].includes(channel))
      throw new Error('未知操作');
    const result = await ipcRenderer.invoke(channel, value);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onState: (fn) => { ipcRenderer.on('state', (_event, value) => fn(value)); },
  onNotice: (fn) => { ipcRenderer.on('notice', (_event, value) => fn(value)); }
});
