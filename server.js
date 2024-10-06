const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const app = express();
const cors = require('cors');
const server = http.createServer(app); // Create http server and bind Express app

// Import the backend module with the WebSocket server function
const backend = require('./backend/index');

// Create WebSocket server using the same HTTP server
backend.createWebSocketServer(server);

// Serve Backend APIs
app.use(cors());
app.use(express.json());
app.use('/api', backend.router);

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend/build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/build', 'index.html'));
});

// Start data-sync server
// const data = spawn('node', ['data/index.js'], { stdio: 'inherit' });

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
