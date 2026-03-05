const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const app = express();
const cors = require('cors');
const server = http.createServer(app); // Create http server and bind Express app

// Import the backend module with the WebSocket server function
const backend = require('./backend/index');
const { startReminderScheduler } = require('./backend/services/reminderScheduler');

// Create WebSocket server using the same HTTP server
backend.createWebSocketServer(server);
startReminderScheduler();

// Serve Backend APIs
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use('/api', backend.router);

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend/build')));

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'frontend/build', 'index.html');
  res.sendFile(indexPath);
});

// Start data-sync server
// const data = spawn('node', ['data/index.js'], { stdio: 'inherit' });

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
