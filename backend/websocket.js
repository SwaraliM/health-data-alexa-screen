// websocket.js
const WebSocket = require('ws');

const clients = new Map();

function createWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
      const data = JSON.parse(message);

      if (data.username) {
        clients.set(data.username, ws);
        console.log(`Client connected: ${data.username}`);
        console.log(`clients size: ${clients.size}`);
      }
    });

    ws.on('close', () => {
      for (let [username, client] of clients) {
        if (client === ws) {
          clients.delete(username);
          console.log(`Client disconnected: ${username}`);
        }
      }
    });
  });
}

function getClients() {
  return clients;
}

module.exports = {
  createWebSocketServer,
  getClients
};
