const express = require("express");
const WebSocket = require("ws");
const connectDB = require('./dbConnect');
const router = require('./routes');
const app = express();


let wss;

function createWebSocketServer(server) {
  wss = new WebSocket.Server({ server });

  wss.on("connection", (ws) => {
    console.log("New WebSocket connection");
    ws.on("message", (message) => {
      console.log(`Received Message: ${message}`);
      ws.send("Hello from WebSocket server");
    });
  });
};

app.use('/', router);

module.exports = {
  router,
  createWebSocketServer,
};
