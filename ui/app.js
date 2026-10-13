const $ = (id) => document.getElementById(id);
let attachment = null, currentState = null, historyKey = '', preparing = false;
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function render(state) {
  currentState = state;
  const connected = state.status.relayConnected > 0;
  const paired = state.status.paired || !!state.status.peerPubkey;
  $('setup').hidden = state.configured;
  $('waiting').hidden = !state.configured || paired;
  $('conversation').hidden = !paired;
  $('mute').hidden = !paired;
  $('mute').textContent = state.muted ? '恢复弹出' : '暂停弹出';
  $('status-dot').className = `dot ${state.status.peerOnline ? 'online' : state.configured ? 'connecting' : ''}`;
  $('status-text').textContent = !state.configured ? '先认识一下彼此' : !connected ? '正在连接网络…' : !paired ? '邀请码已就绪 · 等 TA 加入' : state.status.peerOnline ? `${state.status.peerName || '小伙伴'}在线 · 可以发送消息` : '小伙伴离线 · 上线后再发送';
  if (!$('name').value && state.name) $('name').value = state.name;
  $('invite-code').value = state.invite || '';
  $('friend-label').textContent = `和 ${state.status.peerName || '小伙伴'} 的小纸条`;
  const key = state.history?.map((m) => m.id).join(',');
  if (key !== undefined && key !== historyKey) {
    historyKey = key;
    $('history').replaceChildren();
    for (const message of state.history) {
      const item = document.createElement('article'); item.className = `chat-item ${message.direction}`;
      item.dataset.messageId = message.id;
      const meta = document.createElement('div'); meta.className = 'message-meta';
      const name = document.createElement('span'); name.textContent = message.direction === 'outgoing' ? '我 · 已送达' : message.fromName;
      const time = document.createElement('time'); time.textContent = new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      meta.append(name, time);
      const content = document.createElement('div'); content.className = 'message-card'; renderContent(content, message);
      item.append(meta, content); $('history').append(item);
    }
    $('history').scrollTop = $('history').scrollHeight;
  }
}
async function configure(create) {
  notice();
  try { await call('configure', { name: $('name').value, create, invite: $('invite-input').value }); }
  catch (error) { showError(error); }
}
$('create').addEventListener('click', () => configure(true));
$('join-toggle').addEventListener('click', () => { $('join-form').hidden = !$('join-form').hidden; $('invite-input').focus(); });
$('join-form').addEventListener('submit', (event) => { event.preventDefault(); configure(false); });
$('copy').addEventListener('click', async () => { try { await call('copy-invite'); $('copy').textContent = '已复制 ✓'; setTimeout(() => $('copy').textContent = '复制邀请码 ↗', 1800); } catch (error) { showError(error); } });
$('mute').addEventListener('click', () => call('mute').catch(showError));
$('reset').addEventListener('click', () => call('reset').catch(showError));
$('cancel-invite').addEventListener('click', () => call('reset').catch(showError));
function showAttachment() {
  const container = $('attachment-preview'); container.replaceChildren(); container.hidden = !attachment;
  if (!attachment) return;
  if (attachment.mime.startsWith('image/') && attachment.mime !== 'image/svg+xml') {
    const image = document.createElement('img'); image.src = `data:${attachment.mime};base64,${attachment.data}`; image.alt = ''; container.append(image);
  }
  const name = document.createElement('span'); name.textContent = `${attachment.name} · ${Math.ceil(attachment.data.length * .75 / 1024)} KB`;
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', '移除附件');
  remove.addEventListener('click', () => { if ($('send').disabled) return; attachment = null; $('file-input').value = ''; showAttachment(); }); container.append(name, remove);
}
async function attach(file) {
  if (!file || preparing || $('send').disabled) return;
  preparing = true; notice();
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('单个文件最大 5 MB，请选择较小的文件。');
    let data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('文件读取失败。')); reader.readAsDataURL(file); });
    let mime = file.type || 'application/octet-stream', name = file.name || '粘贴图片.png';
    if (['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      const image = new Image(); image.src = data; await image.decode();
      if (image.width * image.height > 64_000_000) throw new Error('图片尺寸过大，请先缩小。');
      if (file.size > 200 * 1024 || Math.max(image.width, image.height) > 1280) {
        const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        data = canvas.toDataURL('image/jpeg', .84); mime = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg';
      }
    }
    attachment = { name, mime, data: data.slice(data.indexOf(',') + 1) }; showAttachment();
  } catch (error) { showError(error); }
  finally { preparing = false; }
}
$('file-input').addEventListener('change', () => attach($('file-input').files[0]));
document.addEventListener('dragover', (event) => { event.preventDefault(); if (!currentState?.status.paired) return; document.body.classList.add('dropping'); });
document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (event) => { event.preventDefault(); document.body.classList.remove('dropping'); if (currentState?.status.paired) attach(event.dataTransfer.files[0]); });
$('message').addEventListener('paste', (event) => {
  const image = [...event.clipboardData.items].find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (image) { event.preventDefault(); attach(image.getAsFile()); }
});
$('compose-form').addEventListener('submit', async (event) => {
  event.preventDefault(); notice();
  if (preparing) return notice('附件正在准备，请稍候。');
  const text = $('message').value;
  if (!text.trim() && !attachment) return;
  $('send').disabled = true; $('message').disabled = true; $('file-input').disabled = true; $('send').textContent = '送达中…';
  try {
    await call('send', { text, ...(attachment ? { attachment } : {}) });
    $('message').value = ''; attachment = null; $('file-input').value = ''; showAttachment();
  } catch (error) { showError(error); }
  finally { $('send').disabled = false; $('message').disabled = false; $('file-input').disabled = false; $('send').textContent = '发送 ↗'; $('message').focus(); }
});
$('message').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('send').disabled) { event.preventDefault(); $('compose-form').requestSubmit(); } });
window.petlink.onState(render); window.petlink.onNotice((value) => notice(value)); call('get-state').then(render).catch(showError);
