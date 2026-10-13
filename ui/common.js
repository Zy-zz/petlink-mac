const call = (channel, value) => window.petlink.call(channel, value);
function showError(error) {
  const notice = document.getElementById('notice');
  if (notice) { notice.textContent = error.message ?? String(error); notice.hidden = false; }
}
function renderContent(container, message) {
  container.replaceChildren();
  if (message.text) {
    const text = document.createElement('p'); text.className = 'message-text';
    let cursor = 0;
    for (const match of message.text.matchAll(/https?:\/\/[^\s<>"'，。！？、）]+/g)) {
      text.append(document.createTextNode(message.text.slice(cursor, match.index)));
      const link = document.createElement('a'); link.textContent = match[0]; link.href = '#';
      link.addEventListener('click', (event) => { event.preventDefault(); call('link', match[0]).catch(showError); });
      text.append(link); cursor = match.index + match[0].length;
    }
    text.append(document.createTextNode(message.text.slice(cursor))); container.append(text);
  }
  const file = message.attachment;
  if (!file) return;
  const data = `data:${file.mime};base64,${file.data}`;
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime)) {
    const image = document.createElement('img'); image.className = 'message-image'; image.src = data; image.alt = file.name; container.append(image);
  } else if (['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'video/mp4', 'video/webm'].includes(file.mime)) {
    const media = document.createElement(file.mime.startsWith('audio/') ? 'audio' : 'video');
    media.className = 'message-media'; media.controls = true; media.preload = 'metadata'; media.src = data; container.append(media);
  }
  const row = document.createElement('div'); row.className = 'file-card';
  const name = document.createElement('span'); name.textContent = `↳ ${file.name}`;
  const save = document.createElement('button'); save.textContent = '保存';
  save.addEventListener('click', () => call('save-attachment', message.id).catch(showError));
  row.append(name, save); container.append(row);
}
