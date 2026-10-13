/* Native operations are authorized by the Rust backend for each window. */
const subscriptions = [];
window.petlink = {
  call: async (channel, value) => {
    await Promise.all(subscriptions);
    return window.__TAURI__.core.invoke('call', { channel, value: value ?? null });
  },
  onState: fn => subscriptions.push(window.__TAURI__.event.listen('state', event => fn(event.payload))),
  onNotice: fn => subscriptions.push(window.__TAURI__.event.listen('notice', event => fn(event.payload))),
  onQuickAction: fn => subscriptions.push(window.__TAURI__.event.listen('quick-action', event => fn(event.payload))),
  onWalkState: fn => subscriptions.push(window.__TAURI__.event.listen('walk-state', event => fn(Boolean(event.payload))))
};
