let currentId = '';
function render(state) {
  const key = state.latest && `${state.latest.id}:${state.latest.throwState || ''}`;
  if (!state.latest || key === currentId) return;
  currentId = key;
  document.getElementById('sender').textContent = state.latest.fromName;
  renderContent(document.getElementById('content'), state.latest);
}
document.getElementById('dismiss').addEventListener('click', () => call('dismiss').catch(showError));
document.getElementById('reply').addEventListener('click', () => call('open').catch(showError));
window.petlink.onState(render); call('get-state').then(render).catch(showError);
new ResizeObserver(([entry]) => call('bubble-height', entry.target.getBoundingClientRect().height + 36).catch(showError))
  .observe(document.querySelector('.speech'));
