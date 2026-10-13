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
document.getElementById('quick-reply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('quick-reply'), button = document.getElementById('quick-send');
  const text = input.value;
  if (!text.trim()) return;
  input.disabled = true; button.disabled = true; button.textContent = '送达中…';
  try { await call('send', { text }); input.value = ''; await call('dismiss'); }
  catch (error) { showError(error); }
  finally { input.disabled = false; button.disabled = false; button.textContent = '发送 ↗'; input.focus(); }
});
window.petlink.onState(render); call('get-state').then(render).catch(showError);
new ResizeObserver(([entry]) => call('bubble-height', entry.target.getBoundingClientRect().height + 36).catch(showError))
  .observe(document.querySelector('.speech'));
