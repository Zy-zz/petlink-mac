call('get-object').then((message) => {
  const content = document.getElementById('object-content');
  if (message.text) {
    const text = document.createElement('p'); text.className = 'message-text';
    text.textContent = message.text; content.append(text);
  }
  if (message.attachment) {
    const image = document.createElement('img'); image.className = 'message-image';
    image.src = `data:${message.attachment.mime};base64,${message.attachment.data}`;
    image.alt = message.attachment.name; content.append(image);
  }
}).catch(showError);
document.getElementById('close-object').addEventListener('click', () => call('close-object').catch(showError));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') call('close-object').catch(showError); });
new ResizeObserver(([entry]) => call('object-height', entry.borderBoxSize[0].blockSize + 30).catch(showError))
  .observe(document.querySelector('.desktop-object'));
