const { WebSocketServer, WebSocket } = require('ws');

async function startRelay() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 32000 });
  await new Promise(resolve => server.once('listening', resolve));
  const events = [];
  const subscriptions = new Map();
  const relay = {
    url: `ws://127.0.0.1:${server.address().port}`,
    server, events, filter: () => true,
    inject(event) {
      for (const [ws, topic] of subscriptions) {
        if (ws.readyState === WebSocket.OPEN && event.tags?.some(tag => tag[0] === 'x' && tag[1] === topic) && relay.filter(event, ws)) {
          ws.send(JSON.stringify(['EVENT', 'petlink', event]));
        }
      }
    },
    async close() {
      for (const ws of server.clients) ws.terminate();
      await new Promise(resolve => server.close(resolve));
    },
  };
  server.on('connection', ws => {
    ws.on('message', data => {
      const frame = JSON.parse(data.toString());
      if (frame[0] === 'REQ') subscriptions.set(ws, frame[2]['#x'][0]);
      if (frame[0] === 'EVENT') {
        events.push(frame[1]);
        ws.send(JSON.stringify(['OK', frame[1].id, true, '']));
        relay.inject(frame[1]);
      }
    });
    ws.on('close', () => subscriptions.delete(ws));
  });
  return relay;
}
module.exports = { startRelay };
