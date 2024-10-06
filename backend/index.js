const express = require("express");
const WebSocket = require("ws");
const connectDB = require('./dbConnect');
const loginRouter = require('./routers/loginRouter');
const fitbitRouter = require('./routers/fitbitRouter');
const app = express();


let wss;
const clients = new Map();


function createWebSocketServer(server) {
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('New client connected');
  
    ws.on('message', (message) => {
      const data = JSON.parse(message);
      
      if (data.username) {
        clients.set(data.username, ws); 
        console.log(`Client connected: ${data.username}`);
        console.log(`ws: ${ws}`);
        console.log(`========`);
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
  
  
};

connectDB();

const router = express.Router();
router.use('/login', loginRouter);
router.use('/fitbit', fitbitRouter);
app.use('/', router);

module.exports = {
  router,
  createWebSocketServer,
};
