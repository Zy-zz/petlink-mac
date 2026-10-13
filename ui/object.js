call('get-object').then((message) => {
  document.getElementById('object-sender').textContent = `${message.fromName}甩来的小东西`;
  renderContent(document.getElementById('object-content'), message);
}).catch(showError);
document.getElementById('close-object').addEventListener('click', () => call('close-object').catch(showError));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') call('close-object').catch(showError); });
new ResizeObserver(([entry]) => call('object-height', entry.borderBoxSize[0].blockSize + 30).catch(showError))
  .observe(document.querySelector('.desktop-object'));
