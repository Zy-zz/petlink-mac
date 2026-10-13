const call = (channel, value) => window.petlink.call(channel, value);
function showError(error) {
  const notice = document.getElementById('notice');
  if (notice) { notice.textContent = error.message ?? String(error); notice.hidden = false; }
}
function renderContent(container, message) {
  container.replaceChildren();
  if (message.placement && container.id !== 'object-content') {
    const location = document.createElement('p'); location.className = 'throw-location';
    location.textContent = `甩东西请求 · 屏幕 ${message.placement.display} · 左 ${Math.round(message.placement.x * 100)}% / 上 ${Math.round(message.placement.y * 100)}%`;
    container.append(location);
    const status = document.createElement('p'); status.className = 'throw-status';
    status.textContent = message.throwState === 'accepted' ? '已确认接住 ✓' : message.throwState === 'rejected' ? '已拒绝' :
      message.direction === 'outgoing' ? '已送达，等待 TA 确认' : '确认后才会甩到这个位置，5 分钟内有效';
    container.append(status);
    if (message.direction === 'incoming' && message.throwState === 'pending') {
      const actions = document.createElement('div'); actions.className = 'throw-actions';
      for (const [accepted, label] of [[true, '确认接住 ↗'], [false, '拒绝']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = accepted ? 'primary' : 'secondary'; button.textContent = label;
        button.addEventListener('click', async () => {
          actions.querySelectorAll('button').forEach((b) => b.disabled = true);
          try { const result = await call('respond-throw', { requestId: message.id, accepted }); if (result.notice) showError(result.notice); }
          catch (error) { showError(error); actions.querySelectorAll('button').forEach((b) => b.disabled = false); }
        }); actions.append(button);
      }
      container.append(actions);
    }
  }
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
