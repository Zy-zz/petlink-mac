const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petlink', {
  call: async (channel, value) => {
    if (!['get-state', 'set-pet', 'configure', 'copy-invite', 'send', 'open', 'dismiss', 'mute', 'link', 'save-attachment', 'reset', 'bubble-height',
      'drag-start', 'drag-move', 'drag-end', 'pet-menu', 'quick-action', 'pick-target', 'choose-target', 'cancel-target', 'get-object', 'close-object',
      'object-height', 'respond-throw', 'check-update', 'download-update', 'install-update'].includes(channel))
      throw new Error('未知操作');
    const result = await ipcRenderer.invoke(channel, value);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onState: (fn) => { ipcRenderer.on('state', (_event, value) => fn(value)); },
  onNotice: (fn) => { ipcRenderer.on('notice', (_event, value) => fn(value)); },
  onQuickAction: (fn) => { ipcRenderer.on('quick-action', (_event, value) => fn(value)); },
  onWalkState: (fn) => { ipcRenderer.on('walk-state', (_event, value) => fn(Boolean(value))); }
});
