const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { finalizeEvent } = require('nostr-tools');
const { Peer, createIdentity, createInvite, parseInvite, validateMessage } = require('../src/peer.cjs');
const { startRelay } = require('./relay.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transport state');
    await pause(15);
  }
}
async function pair(t) {
  const relay = await startRelay();
  const identity = createIdentity();
  const invite = createInvite(identity);
  const paired = [];
  const alice = new Peer({ identity, invite, name: 'Alice', relays: [relay.url], onPair: value => paired.push(value) });
  const bob = new Peer({ identity: createIdentity(), invite, name: 'Bob', relays: [relay.url] });
  t.after(async () => { alice.stop(); bob.stop(); await relay.close(); });
  alice.start();
  bob.start();
  await until(() => alice.status.peerOnline && bob.status.peerOnline);
  return { alice, bob, relay, invite, paired };
}

test('invites and trust-boundary message validation', () => {
  const identity = createIdentity();
  const invite = createInvite(identity);
  const parsed = parseInvite(invite);
  assert.equal(parsed.hostPubkey, identity.pubkey);
  assert.match(parsed.topic, /^[a-f0-9]{64}$/);
  assert.notEqual(parseInvite(createInvite(identity)).secret, parsed.secret);
  for (const invalid of ['', 'PL1.', 'PL1.!!!!', 'PL1.' + Buffer.from('{}').toString('base64url'), invite + '=']) assert.throws(() => parseInvite(invalid));
  assert.deepEqual(validateMessage({ text: 'https://example.com' }), { text: 'https://example.com' });
  for (const invalid of [null, [], {}, { text: 42 }, { text: 'x'.repeat(4001) }, { text: 'x', sentAt: 1 },
    { attachment: { name: '../evil', mime: 'image/png', data: 'AAAA' } },
    { attachment: { name: 'file', mime: 'text/plain', data: 'a' } },
    { attachment: { name: 'file', mime: 'text/plain', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') } },
  ]) assert.throws(() => validateMessage(invalid));
  const max = { text: '', attachment: { name: 'file.bin', mime: 'application/octet-stream', data: Buffer.alloc(5 * 1024 * 1024).toString('base64') } };
  assert.equal(validateMessage(max).attachment.data.length, max.attachment.data.length);
  assert.throws(() => new Peer({ identity: { ...identity, pubkey: 'a'.repeat(64) }, invite }));
});

test('JSON-persisted identity and pair keys work without native secp256k1 support', () => {
  const { ECDH } = require('node:crypto');
  const original = ECDH.convertKey;
  ECDH.convertKey = () => { throw new Error('Failed to get EC_GROUP'); };
  try {
    const identity = JSON.parse(JSON.stringify(createIdentity()));
    const friend = JSON.parse(JSON.stringify(createIdentity()));
    const invite = createInvite(identity);
    const a = new Peer({ identity, invite, peerPubkey: friend.pubkey });
    const b = new Peer({ identity: friend, invite });
    assert.deepEqual(a.key('pair'), b.key('pair'));
    assert.equal(parseInvite(invite).hostPubkey, identity.pubkey);
  } finally { ECDH.convertKey = original; }
});
test('throw requests and decisions keep their fields through real encrypted relay delivery', async t => {
  const { alice, bob } = await pair(t);
  assert.equal(alice.status.canThrow, true);
  assert.equal(bob.status.canThrow, true);
  const incoming = [];
  bob.on('message', message => incoming.push(message));
  let decision;
  alice.on('message', message => { decision = message; });
  const placement = { display: 2, x: .25, y: .75 };
  const sent = await alice.send({ text: '接住这句话', placement });
  assert.deepEqual(incoming[0].placement, placement);
  await bob.send({ text: '接住了', throwDecision: { requestId: sent.id, accepted: true } });
  assert.deepEqual(decision.throwDecision, { requestId: sent.id, accepted: true });
  await bob.publish({ type: 'hello', name: 'Bob', target: alice.identity.pubkey, at: Date.now() }, 'hello');
  await until(() => !alice.status.canThrow);
});

test('real WebSocket: pin identities, bidirectional text/link/image/file, encrypted fragmentation and dedup', async t => {
  const { alice, bob, relay, paired } = await pair(t);
  assert.equal(alice.status.peerPubkey, bob.identity.pubkey);
  assert.equal(bob.status.peerPubkey, alice.identity.pubkey);
  assert.equal(paired.length, 1);
  assert.equal(paired[0].name, 'Bob');
  const incoming = [];
  bob.on('message', message => incoming.push(message));
  const outgoing = [];
  alice.on('message', message => outgoing.push(message));
  const sent = await alice.send({ text: 'Hello Bob https://example.com/a?q=1' });
  assert.equal(incoming[0].id, sent.id);
  assert.equal(incoming[0].fromName, 'Alice');
  await bob.send({ text: '中文回复', attachment: { name: 'pixel.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' } });
  assert.equal(outgoing[0].attachment.name, 'pixel.png');
  const data = randomBytes(70000).toString('base64');
  const before = relay.events.length;
  await alice.send({ text: '', attachment: { name: 'notes.bin', mime: 'application/octet-stream', data } });
  assert.equal(incoming[1].attachment.data, data);
  const events = relay.events.slice(before).filter(event => event.pubkey === alice.identity.pubkey && JSON.parse(event.content).mode === 'pair');
  const fragments = events.filter(event => JSON.parse(event.content).total > 1);
  assert.ok(fragments.length > 1);
  assert.ok(relay.events.every(event => Buffer.byteLength(event.content) <= 24000));
  assert.ok(relay.events.every(event => !event.content.includes('Hello Bob') && !event.content.includes('中文回复') && !event.content.includes(data)));
  for (const event of fragments) relay.inject(event);
  await pause(200);
  assert.equal(incoming.length, 2, 'replayed ciphertext must not emit a duplicate message');
});

test('recipient ack, not relay OK, completes send; retry deduplicates delivery', async t => {
  const { alice, bob, relay } = await pair(t);
  let received = 0;
  bob.on('message', () => received++);
  relay.filter = event => !(event.pubkey === bob.identity.pubkey && JSON.parse(event.content).mode === 'pair');
  let completed = false;
  const promise = alice.send({ text: 'Only the recipient can confirm this' }).then(() => { completed = true; });
  await until(() => received === 1);
  await pause(250);
  assert.equal(completed, false, 'relay accepts publication but recipient ack is blocked');
  relay.filter = () => true;
  await promise;
  assert.equal(received, 1, 'retry must be acknowledged without redisplaying');
  assert.equal(completed, true);
});

test('fresh authenticated activity lets a peer reply after delayed heartbeats without accepting replays', async t => {
  const { alice, bob, relay } = await pair(t);
  clearInterval(alice.timer);
  clearInterval(bob.timer);
  await pause(100);
  const firstEvent = relay.events.length;
  bob.lastSeen = Date.now() - 21000;
  assert.equal(bob.status.peerOnline, false);
  bob.on('message', () => { alice.lastSeen = Date.now() - 21000; });
  await alice.send({ text: 'Welcome back; reply immediately' });
  assert.equal(bob.status.peerOnline, true, 'receiving a new authenticated message refreshes presence before display');
  assert.equal(alice.status.peerOnline, true, 'ack for a pending message refreshes presence');
  await bob.send({ text: 'I can reply while heartbeat timers are delayed' });
  bob.lastSeen = Date.now() - 21000;
  const pingStart = relay.events.length;
  await alice.publish({ type: 'ping', challenge: randomUUID(), at: Date.now() });
  await until(() => bob.status.peerOnline);
  const ping = relay.events.slice(pingStart).find(event => event.pubkey === alice.identity.pubkey);
  assert.ok(ping);
  bob.lastSeen = Date.now() - 21000;
  const expired = bob.lastSeen;
  for (const event of relay.events.slice(firstEvent).filter(event => event.pubkey === alice.identity.pubkey)) relay.inject(event);
  await pause(150);
  assert.equal(bob.lastSeen, expired, 'replayed message, ack and ping frames cannot extend presence');
  await alice.publish({ type: 'ack', id: randomUUID(), at: Date.now() });
  await pause(100);
  assert.equal(bob.lastSeen, expired, 'an unmatched ack cannot extend presence');
  const oldPing = finalizeEvent({ kind: ping.kind, tags: ping.tags, created_at: Math.floor(Date.now() / 1000) - 30,
    content: JSON.stringify({ ...JSON.parse(ping.content), id: randomUUID() }) }, Buffer.from(alice.identity.secretKey, 'hex'));
  relay.inject(oldPing);
  await pause(100);
  assert.equal(bob.lastSeen, expired, 'an unseen but old signed ping cannot extend presence');
  bob.lastSeen = 0;
  await alice.publish({ type: 'ping', challenge: randomUUID(), at: Date.now() });
  await pause(100);
  assert.equal(bob.status.peerOnline, false, 'a ping cannot replace the initial challenge-response proof');
});

test('old signed bye cannot clear a restarted peer, while concurrent challenges still allow normal stop', async t => {
  const relays = await Promise.all([startRelay(), startRelay()]);
  const aIdentity = createIdentity(), bIdentity = createIdentity(), invite = createInvite(aIdentity);
  const options = { invite, relays: relays.map(relay => relay.url) };
  let a = new Peer({ ...options, identity: aIdentity }), b = new Peer({ ...options, identity: bIdentity });
  t.after(async () => { a.stop(); b.stop(); await Promise.all(relays.map(relay => relay.close())); });
  a.start(); b.start();
  await until(() => a.status.peerOnline && b.status.peerOnline);
  const start = relays[0].events.length;
  a.stop();
  await until(() => !b.status.peerOnline);
  const oldBye = relays[0].events.slice(start).find(event => event.pubkey === aIdentity.pubkey && JSON.parse(event.content).mode === 'pair');
  assert.ok(oldBye);
  a = new Peer({ ...options, identity: aIdentity, peerPubkey: bIdentity.pubkey });
  a.start();
  await until(() => a.status.peerOnline && b.status.peerOnline);
  b.stop();
  await until(() => !a.status.peerOnline);
  b = new Peer({ ...options, identity: bIdentity, peerPubkey: aIdentity.pubkey });
  b.start();
  await until(() => a.status.peerOnline && b.status.peerOnline);
  await a.publish({ type: 'bye', challenge: randomUUID(), at: Date.now() });
  await a.publish({ type: 'bye', at: Date.now() });
  await pause(50);
  assert.equal(b.status.peerOnline, true, 'a signed bye without a completed challenge cannot mark the peer offline');
  relays.forEach(relay => relay.inject(oldBye));
  await pause(150);
  assert.equal(b.status.peerOnline, true, 'prior receiver-instance challenge must not authorize a replayed bye');
  a.hello(); a.hello(); b.hello(); b.hello();
  await pause(150);
  a.stop();
  await until(() => !b.status.peerOnline);
  assert.equal(b.lastSeen, 0, 'a current-instance bye must immediately mark the sender offline');
});

test('reject third identities, invalid signatures, modified ciphertext and malformed decrypted messages', async t => {
  const { alice, bob, relay, invite } = await pair(t);
  const received = [];
  bob.on('message', message => received.push(message));
  const third = new Peer({ identity: createIdentity(), invite, name: 'Intruder', relays: [relay.url] });
  t.after(() => third.stop());
  third.start();
  await until(() => third.status.relayConnected === 1);
  await pause(200);
  assert.equal(alice.status.peerPubkey, bob.identity.pubkey);
  assert.equal(third.status.peerOnline, false);
  await assert.rejects(third.send({ text: 'Third party' }), /离线/);
  await alice.send({ text: 'Valid message' });
  const valid = relay.events.find(event => event.pubkey === alice.identity.pubkey && JSON.parse(event.content).mode === 'pair' && JSON.parse(event.content).total === 1);
  relay.inject({ ...valid, sig: '0'.repeat(128) });
  const fragment = JSON.parse(valid.content);
  const sealed = Buffer.from(fragment.data, 'base64');
  sealed[sealed.length - 1] ^= 1;
  const tampered = finalizeEvent({ kind: valid.kind, created_at: Math.floor(Date.now() / 1000), tags: valid.tags,
    content: JSON.stringify({ ...fragment, id: randomUUID(), data: sealed.toString('base64') }) }, Buffer.from(alice.identity.secretKey, 'hex'));
  relay.inject(tampered);
  await alice.publish({ type: 'message', at: Date.now(), message: { text: 'bad', id: randomUUID(), sentAt: 1, fromName: 'Alice' } });
  await alice.publish({ type: 'message', at: Date.now(), message: { text: 'x'.repeat(4001), id: randomUUID(), sentAt: Date.now(), fromName: 'Alice' } });
  await pause(250);
  assert.equal(received.length, 1);
});

test('offline rejection, reconnect and stop reject unconfirmed delivery', async t => {
  const { alice, bob, relay } = await pair(t);
  const disconnected = new Peer({ identity: createIdentity(), invite: createInvite(createIdentity()), relays: [relay.url] });
  await assert.rejects(disconnected.send({ text: 'offline' }), /离线/);
  for (const ws of relay.server.clients) ws.terminate();
  await until(() => alice.status.relayConnected === 0);
  await until(() => alice.status.relayConnected === 1 && bob.status.relayConnected === 1);
  relay.filter = event => event.pubkey !== bob.identity.pubkey;
  const pending = alice.send({ text: 'No acknowledgement' });
  await pause(150);
  alice.stop();
  await assert.rejects(pending, /关闭/);
  await assert.rejects(alice.send({ text: 'stopped' }), /离线/);
});

test('a full 5 MiB file arrives within the 45-second ack deadline', async t => {
  const { alice, bob } = await pair(t);
  const data = Buffer.alloc(5 * 1024 * 1024, 42).toString('base64');
  let received;
  bob.on('message', message => { received = message; });
  const at = Date.now();
  await alice.send({ text: 'Large file', attachment: { name: 'five-mib.bin', mime: 'application/octet-stream', data } });
  assert.ok(Date.now() - at < 45000);
  assert.equal(received.attachment.data, data);
  assert.equal(alice.status.peerOnline, true, 'heartbeat must not queue behind file fragments');
  bob.stop();
  await until(() => !alice.status.peerOnline);
  await assert.rejects(alice.send({ text: 'Now offline' }), /离线/);
});
