const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, hkdfSync } = require('node:crypto');
const WebSocket = require('ws');
const { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } = require('nostr-tools');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://nostr.mom', 'wss://relay.snort.social'];
const KIND = 24747;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_PACKET = Math.ceil(MAX_FILE / 3) * 4 + 32000;
const CHUNK = 23000;
const MAX_PARTS = Math.ceil((MAX_PACKET + 32) * 4 / 3 / CHUNK);
const STALE_MS = 20000;
const ACK_MS = 45000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topicFor = secret => createHash('sha256').update(`petlink-v1:${secret}`).digest('hex');
function validPubkey(value) {
  if (typeof value !== 'string' || !HEX.test(value)) return false;
  try { secp256k1.Point.fromHex('02' + value).assertValidity(); return true; }
  catch { return false; }
}

function createIdentity() {
  const key = generateSecretKey();
  return { secretKey: Buffer.from(key).toString('hex'), pubkey: getPublicKey(key) };
}
function createInvite(identity) {
  if (!identity || !validPubkey(identity.pubkey)) throw new Error('客户端身份无效');
  return 'PL1.' + Buffer.from(JSON.stringify({ secret: randomBytes(32).toString('hex'), hostPubkey: identity.pubkey })).toString('base64url');
}
function parseInvite(value) {
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^PL1\.[A-Za-z0-9_-]+$/.test(value.trim())) throw 0;
    const encoded = value.trim().slice(4);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw 0;
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed.secret !== 'string' || !HEX.test(parsed.secret) || !validPubkey(parsed.hostPubkey)) throw 0;
    return { secret: parsed.secret, hostPubkey: parsed.hostPubkey, topic: topicFor(parsed.secret) };
  } catch { throw new Error('邀请无效，请复制完整的 PL1 邀请码'); }
}
function validateMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('消息格式无效');
  const text = input.text ?? '';
  if (typeof text !== 'string' || text.length > 4000) throw new Error('文字最多 4000 个字符');
  const out = { text };
  if (input.attachment != null) {
    const a = input.attachment;
    if (!a || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 255 || /[\x00-\x1f/\\]/.test(a.name) ||
        typeof a.mime !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.mime) || a.mime.length > 128 ||
        typeof a.data !== 'string' || a.data.length > Math.ceil(MAX_FILE / 3) * 4 || !BASE64.test(a.data)) throw new Error('附件格式无效，最大 5 MiB');
    const bytes = Buffer.from(a.data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE || bytes.toString('base64') !== a.data) throw new Error('附件格式无效，最大 5 MiB');
    out.attachment = { name: a.name, mime: a.mime, data: a.data };
  }
  if (!text.trim() && !out.attachment) throw new Error('请输入文字或添加附件');
  if (input.id != null) {
    if (typeof input.id !== 'string' || !UUID.test(input.id)) throw new Error('消息 ID 无效');
    out.id = input.id;
  }
  if (input.sentAt != null) {
    if (!Number.isSafeInteger(input.sentAt) || Math.abs(Date.now() - input.sentAt) > 120000) throw new Error('消息已过期');
    out.sentAt = input.sentAt;
  }
  if (input.fromName != null) {
    if (typeof input.fromName !== 'string' || !input.fromName.trim() || input.fromName.length > 40) throw new Error('发送者名称无效');
    out.fromName = input.fromName;
  }
  return out;
}

class Peer extends EventEmitter {
  constructor({ identity, invite, peerPubkey = null, name = '朋友', relays = DEFAULT_RELAYS, onPair }) {
    super();
    if (!identity || !HEX.test(identity.secretKey) || !HEX.test(identity.pubkey) || getPublicKey(Buffer.from(identity.secretKey, 'hex')) !== identity.pubkey) throw new Error('客户端身份无效');
    this.identity = { ...identity };
    this.invite = typeof invite === 'string' ? parseInvite(invite) : parseInvite('PL1.' + Buffer.from(JSON.stringify(invite)).toString('base64url'));
    if (peerPubkey && (!validPubkey(peerPubkey) || peerPubkey === identity.pubkey)) throw new Error('好友身份无效');
    if (typeof name !== 'string' || !name.trim() || name.length > 40) throw new Error('名称最多 40 个字符');
    if (!Array.isArray(relays) || !relays.length || relays.length > 8 || relays.some(url => typeof url !== 'string' || !/^wss?:\/\//.test(url))) throw new Error('中继地址无效');
    try { for (const url of relays) { const parsed = new URL(url); if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) throw 0; } }
    catch { throw new Error('中继地址无效'); }
    this.name = name;
    this.relays = [...new Set(relays)];
    this.onPair = onPair;
    this.peerPubkey = peerPubkey || (identity.pubkey === this.invite.hostPubkey ? null : this.invite.hostPubkey);
    if (identity.pubkey !== this.invite.hostPubkey && this.peerPubkey !== this.invite.hostPubkey) throw new Error('好友身份与邀请不匹配');
    this.peerName = '';
    this.lastSeen = 0;
    this.running = false;
    this.sockets = new Map();
    this.retryTimers = new Set();
    this.assemblies = new Map();
    this.delivered = new Map();
    this.controls = new Map();
    this.pending = new Map();
    this.challenges = new Map();
    this.completedChallenges = new Set();
    this.remoteChallenge = null;
    this.queue = Promise.resolve();
    this.sendQueue = Promise.resolve();
    this.roomKey = Buffer.from(this.invite.secret, 'hex');
    this.pairNotified = false;
  }
  get status() {
    const relayConnected = [...this.sockets.values()].filter(ws => ws.readyState === WebSocket.OPEN).length;
    return { relayConnected,
      peerOnline: this.running && relayConnected > 0 && Date.now() - this.lastSeen < STALE_MS && this.lastSeen > 0,
      paired: !!this.peerPubkey, peerName: this.peerName, peerPubkey: this.peerPubkey };
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.relays.forEach(url => this.connect(url));
    this.timer = setInterval(() => {
      this.hello();
      const cutoff = Date.now() - 60000;
      for (const [id, a] of this.assemblies) if (a.at < cutoff) this.assemblies.delete(id);
      for (const [id, at] of this.delivered) if (at < Date.now() - 180000) this.delivered.delete(id);
      for (const [id, at] of this.controls) if (at < Date.now() - 180000) this.controls.delete(id);
      for (const [id, at] of this.challenges) if (at < Date.now() - STALE_MS) this.challenges.delete(id);
      this.emit('status', this.status);
    }, 5000);
  }
  stop() {
    if (!this.running) return;
    if (this.peerPubkey && this.remoteChallenge && this.status.relayConnected) {
      this.publish({ type: 'bye', challenge: this.remoteChallenge, at: Date.now() }).catch(() => {});
    }
    this.running = false;
    clearInterval(this.timer);
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    this.assemblies.clear();
    this.challenges.clear();
    this.completedChallenges.clear();
    this.remoteChallenge = null;
    this.lastSeen = 0;
    for (const p of this.pending.values()) p.reject(new Error('连接已关闭，消息未确认送达'));
    this.pending.clear();
    this.emit('status', this.status);
  }
  fail(error) { if (this.listenerCount('error')) this.emit('error', error); }
  connect(url) {
    if (!this.running) return;
    const ws = new WebSocket(url, { maxPayload: 32000, handshakeTimeout: 10000 });
    this.sockets.set(url, ws);
    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', 'petlink', { kinds: [KIND], '#x': [this.invite.topic], since: Math.floor(Date.now() / 1000) - 120 }]));
      this.emit('status', this.status);
      this.hello();
    });
    ws.on('message', data => {
      try { const frame = JSON.parse(data.toString()); if (frame[0] === 'EVENT' && frame[1] === 'petlink') this.receive(frame[2]); }
      catch { /* Ignore malformed relay frames. */ }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.sockets.get(url) !== ws) return;
      this.sockets.delete(url);
      this.emit('status', this.status);
      if (this.running) {
        const timer = setTimeout(() => { this.retryTimers.delete(timer); this.connect(url); }, 3000);
        this.retryTimers.add(timer);
      }
    });
  }
  key(mode, pubkey = this.peerPubkey) {
    if (mode === 'hello') return this.roomKey;
    if (!pubkey) throw new Error('尚未配对');
    // Electron's BoringSSL omits secp256k1; reuse the curve implementation used for Nostr signatures.
    const shared = secp256k1.getSharedSecret(Buffer.from(this.identity.secretKey, 'hex'), Buffer.from('02' + pubkey, 'hex')).subarray(1, 33);
    return Buffer.from(hkdfSync('sha256', shared, this.roomKey, Buffer.from('petlink-v1-pair'), 32));
  }
  hello() {
    if (!this.running || !this.status.relayConnected) return;
    this.publish({ type: 'hello', name: this.name, target: this.peerPubkey, at: Date.now() }, 'hello').catch(error => this.fail(error));
  }
  publish(packet, mode = 'pair', deadline = Infinity) {
    const run = async () => {
      if (!this.running) throw new Error('连接已关闭');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key(mode), nonce);
      cipher.setAAD(Buffer.from(this.invite.topic + ':' + mode));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(packet), 'utf8'), cipher.final()]);
      const encoded = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
      const id = randomUUID();
      const total = Math.ceil(encoded.length / CHUNK);
      for (let part = 0; part < total; part++) {
        if (!this.running) throw new Error('连接已关闭');
        if (Date.now() >= deadline) throw new Error('对方未确认收到消息，请检查双方连接后重试');
        const event = finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['x', this.invite.topic]],
          content: JSON.stringify({ v: 1, id, part, total, mode, data: encoded.slice(part * CHUNK, (part + 1) * CHUNK) }) }, Buffer.from(this.identity.secretKey, 'hex'));
        let count = 0;
        for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(['EVENT', event])); count++; }
        if (!count) throw new Error('中继未连接，消息未送达');
        if (total > 1) await sleep(80);
      }
    };
    const result = packet.type === 'message' ? this.queue.then(run) : run();
    if (packet.type === 'message') this.queue = result.catch(() => {});
    return result;
  }
  receive(event) {
    try {
      if (!event || event.kind !== KIND || event.pubkey === this.identity.pubkey || !HEX.test(event.pubkey) ||
          typeof event.content !== 'string' || event.content.length > 24000 || !Array.isArray(event.tags) ||
          event.tags.length !== 1 || event.tags[0].length !== 2 || event.tags[0][0] !== 'x' || event.tags[0][1] !== this.invite.topic ||
          !Number.isSafeInteger(event.created_at) || Math.abs(Date.now() / 1000 - event.created_at) > 120 ||
          (this.peerPubkey && event.pubkey !== this.peerPubkey) || !verifyEvent(event)) return;
      const f = JSON.parse(event.content);
      if (f.v !== 1 || !UUID.test(f.id) || !['hello', 'pair'].includes(f.mode) || !Number.isInteger(f.total) || f.total < 1 || f.total > MAX_PARTS ||
          !Number.isInteger(f.part) || f.part < 0 || f.part >= f.total || typeof f.data !== 'string' || f.data.length > CHUNK || !f.data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(f.data) ||
          (f.mode === 'hello' && f.total !== 1) || (f.mode === 'pair' && !this.peerPubkey)) return;
      const key = event.pubkey + ':' + f.id;
      let a = this.assemblies.get(key);
      if (!a) {
        if (this.assemblies.size >= 4) return;
        a = { parts: new Map(), total: f.total, mode: f.mode, at: Date.now(), bytes: 0, latest: event.created_at };
        this.assemblies.set(key, a);
      }
      if (a.total !== f.total || a.mode !== f.mode) return;
      a.latest = Math.max(a.latest, event.created_at);
      if (!a.parts.has(f.part)) { a.parts.set(f.part, f.data); a.bytes += f.data.length; }
      if (a.bytes > MAX_PARTS * CHUNK) { this.assemblies.delete(key); return; }
      if (a.parts.size !== a.total) return;
      this.assemblies.delete(key);
      const encoded = Array.from({ length: a.total }, (_, i) => a.parts.get(i)).join('');
      if (!BASE64.test(encoded)) return;
      const sealed = Buffer.from(encoded, 'base64');
      if (sealed.length < 29 || sealed.length > MAX_PACKET + 28 || sealed.toString('base64') !== encoded) return;
      const decipher = createDecipheriv('aes-256-gcm', this.key(a.mode, event.pubkey), sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(this.invite.topic + ':' + a.mode));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const packet = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8'));
      if (!packet || !Number.isSafeInteger(packet.at) || Math.abs(Date.now() - packet.at) > 120000) return;
      if (packet.type !== 'message') {
        if (this.controls.has(key) || this.controls.size >= 2000) return;
        this.controls.set(key, Date.now());
      }
      if (packet.type === 'hello' && a.mode === 'hello') {
        if (typeof packet.name !== 'string' || !packet.name.trim() || packet.name.length > 40 ||
            (packet.target !== null && packet.target !== this.identity.pubkey) || (!this.peerPubkey && packet.target !== this.identity.pubkey)) return;
        if (!this.pairNotified) {
          try { this.onPair?.({ pubkey: event.pubkey, name: packet.name }); }
          catch (error) { this.fail(error); return; }
          this.peerPubkey = event.pubkey;
          this.pairNotified = true;
          this.emit('paired', { pubkey: event.pubkey, name: packet.name });
          this.hello();
        }
        this.peerName = packet.name;
        // Presence is proved by a fresh challenge response, so replayed hello cannot mark a peer online.
        if (this.challenges.size < 8) {
          const challenge = randomUUID();
          this.challenges.set(challenge, Date.now());
          this.publish({ type: 'ping', challenge, at: Date.now() }).catch(error => this.fail(error));
        }
      } else if (a.mode === 'pair' && event.pubkey === this.peerPubkey) {
        const recent = Math.abs(Date.now() / 1000 - a.latest) < STALE_MS / 1000;
        const freshActivity = this.lastSeen > 0 && recent;
        if (packet.type === 'ping' && UUID.test(packet.challenge)) {
          if (recent) this.remoteChallenge = packet.challenge;
          if (freshActivity) this.lastSeen = Date.now();
          this.publish({ type: 'pong', challenge: packet.challenge, at: Date.now() }).catch(error => this.fail(error));
        } else if (packet.type === 'pong' && UUID.test(packet.challenge) && this.challenges.has(packet.challenge) &&
                   Date.now() - this.challenges.get(packet.challenge) < STALE_MS) {
          this.challenges.delete(packet.challenge);
          this.completedChallenges.add(packet.challenge);
          if (this.completedChallenges.size > 8) this.completedChallenges.delete(this.completedChallenges.values().next().value);
          this.lastSeen = Date.now();
        } else if (packet.type === 'ack' && UUID.test(packet.id)) {
          const pending = this.pending.get(packet.id);
          if (pending && freshActivity) this.lastSeen = Date.now();
          pending?.resolve();
        } else if (packet.type === 'bye' && UUID.test(packet.challenge) && this.completedChallenges.has(packet.challenge)) {
          this.lastSeen = 0;
          this.challenges.clear();
          this.completedChallenges.clear();
          this.remoteChallenge = null;
        } else if (packet.type === 'message') {
          const message = validateMessage(packet.message);
          if (!message.id || !message.sentAt || !message.fromName) return;
          if (!this.delivered.has(message.id)) {
            if (this.delivered.size >= 2000) return;
            if (freshActivity) this.lastSeen = Date.now();
            try { this.emit('message', message); }
            catch (error) { this.fail(error); return; }
            this.delivered.set(message.id, Date.now());
          }
          this.publish({ type: 'ack', id: message.id, at: Date.now() }).catch(error => this.fail(error));
        }
      }
      this.emit('status', this.status);
    } catch { /* Reject invalid signatures, ciphertext, fragments and untrusted payloads. */ }
  }
  send(input) {
    const run = async () => {
      const message = { ...validateMessage(input), id: randomUUID(), sentAt: Date.now(), fromName: this.name };
      if (!this.status.peerOnline) throw new Error('好友离线，请等对方上线后再发送');
      let acknowledged = false;
      let rejected;
      this.pending.set(message.id, { resolve: () => { acknowledged = true; }, reject: error => { rejected = error; } });
      const deadline = Date.now() + ACK_MS;
      try {
        do {
          if (rejected) throw rejected;
          if (!this.running) throw new Error('连接已关闭，消息未确认送达');
          await this.publish({ type: 'message', message, at: Date.now() }, 'pair', deadline);
          const waitUntil = Math.min(Date.now() + 4000, deadline);
          while (!acknowledged && !rejected && Date.now() < waitUntil) await sleep(50);
          if (acknowledged) return message;
        } while (Date.now() < deadline);
        if (rejected) throw rejected;
        throw new Error('对方未确认收到消息，请检查双方连接后重试');
      } finally { this.pending.delete(message.id); }
    };
    const result = this.sendQueue.then(run);
    this.sendQueue = result.catch(() => {});
    return result;
  }
}
module.exports = { Peer, createIdentity, createInvite, parseInvite, validateMessage, DEFAULT_RELAYS };
