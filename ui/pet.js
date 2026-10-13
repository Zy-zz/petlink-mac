let unreadCount = 0;
function render(state) {
  const pet = document.getElementById('pet');
  const badge = document.getElementById('badge');
  badge.hidden = !state.unread; badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
  document.getElementById('pet-name').textContent = state.unread ? 'TA 有话想对你说' : state.muted ? '安静陪着你' : state.status.peerOnline ? `${state.status.peerName || '小伙伴'}在这里` : '小伙伴在这里';
  if (state.unread > unreadCount) { pet.classList.remove('new-message'); requestAnimationFrame(() => pet.classList.add('new-message')); }
  unreadCount = state.unread;
}
document.getElementById('pet').addEventListener('click', () => call('open').catch(showError));
window.petlink.onState(render); call('get-state').then(render).catch(showError);
