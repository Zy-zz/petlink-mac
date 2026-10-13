let unreadCount = 0;
function render(state) {
  const pet = document.getElementById('pet');
  const badge = document.getElementById('badge');
  badge.hidden = !state.unread; badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
  document.getElementById('pet-name').textContent = state.unread ? 'TA 有话想对你说' : state.muted ? '安静陪着你' : state.status.peerOnline ? `${state.status.peerName || '小伙伴'}在这里` : '小伙伴在这里';
  if (state.unread > unreadCount) { pet.classList.remove('new-message'); requestAnimationFrame(() => pet.classList.add('new-message')); }
  unreadCount = state.unread;
}
const button = document.getElementById('pet');
let origin = null, dragging = false, start = Promise.resolve();
button.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault(); button.setPointerCapture(event.pointerId);
  origin = { x: event.screenX, y: event.screenY }; dragging = false;
  start = call('drag-start').catch(showError);
});
button.addEventListener('pointermove', (event) => {
  if (!origin) return;
  if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) > 4) dragging = true;
  if (dragging) { button.classList.add('dragging'); start.then(() => call('drag-move')).catch(showError); }
});
function release(event) {
  if (!origin) return;
  const wasDragging = dragging; origin = null; dragging = false; button.classList.remove('dragging');
  start.then(() => call('drag-end')).then(() => {
    if (!wasDragging && event.type === 'pointerup') return call('open');
  }).catch(showError);
}
button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release);
button.addEventListener('click', (event) => { if (event.detail === 0) call('open').catch(showError); });
window.petlink.onState(render); call('get-state').then(render).catch(showError);
