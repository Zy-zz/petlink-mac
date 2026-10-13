// Manual network probe: node test/public-relay.cjs. Never writes identities or invites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { crc32, inflateSync } = require('node:zlib');
const { Peer, createIdentity, createInvite, DEFAULT_RELAYS } = require('../src/peer.cjs');

const fallback = ['wss://relay.agentry.com', 'wss://relay.routstr.com', 'wss://nostr.rblb.it'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scrub = value => String(value).replace(/PL1\.[A-Za-z0-9_-]+/g, '[invite]').replace(/[a-f0-9]{64}/gi, '[key]').slice(0, 250);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
for (let offset = 8; offset < png.length;) {
  const length = png.readUInt32BE(offset);
  const chunk = png.subarray(offset + 4, offset + 8 + length);
  assert.equal(crc32(chunk), png.readUInt32BE(offset + 8 + length));
  if (chunk.subarray(0, 4).toString() === 'IDAT') assert.equal(inflateSync(chunk.subarray(4)).length, 3);
  offset += length + 12;
}

async function attempt(relays) {
  const identity = createIdentity();
  const invite = createInvite(identity);
  const a = new Peer({ identity, invite, name: '公共测试 A', relays });
  const b = new Peer({ identity: createIdentity(), invite, name: '公共测试 B', relays });
  const result = { startedAt: new Date().toISOString(), relays: Object.fromEntries(relays.map(url => [url, { opened: 0, accepted: 0, rejected: [], notices: [], socketErrors: [] }])),
    paired: false, messages: [], errors: [], outcome: 'unknown' };
  const seen = new WeakSet();
  const hook = peer => {
    for (const [url, ws] of peer.sockets) {
      if (seen.has(ws)) continue;
      seen.add(ws);
      const info = result.relays[url];
      ws.on('open', () => info.opened++);
      ws.on('error', error => { if (info.socketErrors.length < 8) info.socketErrors.push(scrub(error.message)); });
      ws.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame[0] === 'OK' && frame[2] === true) info.accepted++;
          if (frame[0] === 'OK' && frame[2] === false && info.rejected.length < 8) info.rejected.push(scrub(frame[3]));
          if (frame[0] === 'NOTICE' && info.notices.length < 8) info.notices.push(scrub(frame[1]));
        } catch {}
      });
    }
  };
  const inbox = new Map();
  for (const peer of [a, b]) {
    peer.on('status', () => hook(peer));
    peer.on('error', error => { if (result.errors.length < 8) result.errors.push(scrub(error.message)); });
    peer.on('message', message => inbox.set(message.id, message));
    peer.start();
    hook(peer);
  }
  try {
    const deadline = Date.now() + 60000;
    while (!(a.status.peerOnline && b.status.peerOnline) && Date.now() < deadline) await pause(100);
    result.paired = a.status.peerOnline && b.status.peerOnline;
    if (!result.paired) { result.outcome = 'pairing-timeout'; return result; }
    const cases = [
      [a, 'text+link', { text: '你好，桌面小伙伴！ https://example.com/petlink' }],
      [b, 'PNG', { text: '图片回复', attachment: { name: 'pixel.png', mime: 'image/png', data: png.toString('base64') } }],
      [a, '30-KiB-file', { text: '分片文件测试', attachment: { name: 'random.bin', mime: 'application/octet-stream', data: randomBytes(30 * 1024).toString('base64') } }],
      [b, 'reply', { text: '收到，双向通信确认。 https://example.com/reply' }],
    ];
    for (const [peer, label, input] of cases) {
      const started = Date.now();
      const sent = await peer.send(input);
      const received = inbox.get(sent.id);
      assert.ok(received, 'recipient must receive before sender resolves');
      assert.equal(received.text, input.text);
      if (input.attachment) assert.deepEqual(received.attachment, input.attachment);
      result.messages.push({ type: label, acknowledgedByRecipient: true, bytes: input.attachment ? Buffer.from(input.attachment.data, 'base64').length : Buffer.byteLength(input.text), elapsedMs: Date.now() - started });
    }
    assert.equal(a.status.canThrow, true);
    const at = Date.now();
    const placement = { display: 1, x: .3, y: .28 };
    const request = await a.send({ text: '公网甩东西请求测试', placement, attachment: { name: 'pixel.png', mime: 'image/png', data: png.toString('base64') } });
    assert.deepEqual(inbox.get(request.id).placement, placement);
    const response = await b.send({ text: '测试客户端确认收到', throwDecision: { requestId: request.id, accepted: true } });
    assert.deepEqual(inbox.get(response.id).throwDecision, { requestId: request.id, accepted: true });
    result.messages.push({ type: 'throw-request+decision', acknowledgedByRecipient: true, elapsedMs: Date.now() - at,
      scope: 'Protocol fields and recipient ack only; native consent and placement are tested separately in UI tests.' });
    result.outcome = 'success';
  } catch (error) {
    result.outcome = 'failed';
    result.errors.push(scrub(error.message));
  } finally {
    result.endedAt = new Date().toISOString();
    result.connectedAtEnd = { a: a.status.relayConnected, b: b.status.relayConnected };
    a.stop(); b.stop();
  }
  return result;
}

(async () => {
  const result = { testedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
    topology: 'Two clients on this one Mac, through public internet Nostr relays; not two physical Macs or separate networks.', attempts: [] };
  result.attempts.push(await attempt(DEFAULT_RELAYS));
  if (result.attempts[0].outcome !== 'success') result.attempts.push(await attempt(fallback));
  result.outcome = result.attempts.some(item => item.outcome === 'success') ? 'success' : 'unknown';
  const target = path.join(__dirname, '../test-output/public-relay-result.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.outcome === 'success' ? 0 : 1;
})().catch(error => { console.error(scrub(error.message)); process.exitCode = 1; });
