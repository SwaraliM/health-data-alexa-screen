// websocket.js
const WebSocket = require('ws');

const clients = new Map();

function getClientUsernames() {
  return Array.from(clients.keys());
}

function createWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    // console.log('[backend websocket] new client connected', {
    //   registeredClients: getClientUsernames(),
    // });

    ws.on('message', (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (error) {
        console.warn('[backend websocket] dropped malformed registration payload', {
          error: error.message,
        });
        return;
      }

      if (data.username) {
        const userKey = String(data.username).trim().toLowerCase();
        clients.set(userKey, ws);
        // console.log('[backend websocket] client registered', {
        //   username: userKey,
        //   clientCount: clients.size,
        //   registeredClients: getClientUsernames(),
        // });
      }
    });

    ws.on('close', () => {
      for (let [username, client] of clients) {
        if (client === ws) {
          clients.delete(username);
          console.log('[backend websocket] client disconnected', {
            username,
            clientCount: clients.size,
            registeredClients: getClientUsernames(),
          });
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
