document.addEventListener('pointermove', (event) => {
  const cursor = document.getElementById('crosshair'); cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`;
});
document.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  call('choose-target', { x: event.clientX / innerWidth, y: event.clientY / innerHeight }).catch(showError);
});
document.getElementById('cancel-target').addEventListener('click', () => call('cancel-target').catch(showError));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') call('cancel-target').catch(showError); });
