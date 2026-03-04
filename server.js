const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// #region agent log
const _logPath = path.join(__dirname, '..', '.cursor', 'debug-80789f.log');
function _dbg(payload) {
  const line = JSON.stringify({ sessionId: '80789f', ...payload, timestamp: Date.now() }) + '\n';
  try { fs.appendFileSync(_logPath, line); } catch (_) {}
}
// #endregion

const app = express();
const cors = require('cors');
const server = http.createServer(app); // Create http server and bind Express app

// #region agent log
const _frontendBuildPath = path.join(__dirname, 'frontend/build');
_dbg({ location: 'server.js:resolvePath', message: 'Frontend build path resolved', data: { path: _frontendBuildPath, indexExists: fs.existsSync(path.join(_frontendBuildPath, 'index.html')) }, hypothesisId: 'C' });
// #endregion

// Import the backend module with the WebSocket server function
const backend = require('./backend/index');
const { startReminderScheduler } = require('./backend/services/reminderScheduler');

// Create WebSocket server using the same HTTP server
backend.createWebSocketServer(server);
startReminderScheduler();
// #region agent log
_dbg({ location: 'server.js:afterStartup', message: 'Past WebSocket and reminder scheduler', data: {}, hypothesisId: 'A' });
// #endregion

// Serve Backend APIs
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// #region agent log
app.use((req, res, next) => {
  _dbg({ location: 'server.js:request', message: 'Incoming request', data: { method: req.method, url: req.url }, hypothesisId: 'E' });
  next();
});
// #endregion

app.use('/api', backend.router);

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend/build')));

app.get('*', (req, res) => {
  // #region agent log
  _dbg({ location: 'server.js:spaFallback', message: 'Sending index.html for SPA', data: { url: req.url }, hypothesisId: 'B' });
  // #endregion
  const indexPath = path.join(__dirname, 'frontend/build', 'index.html');
  res.sendFile(indexPath, (err) => {
    // #region agent log
    if (err) _dbg({ location: 'server.js:sendFileCb', message: 'sendFile error', data: { error: String(err), path: indexPath }, hypothesisId: 'D' });
    // #endregion
  });
});

// Start data-sync server
// const data = spawn('node', ['data/index.js'], { stdio: 'inherit' });

const PORT = process.env.PORT || 5001;
// #region agent log
_dbg({ location: 'server.js:beforeListen', message: 'About to call server.listen', data: { port: PORT }, hypothesisId: 'A' });
// #endregion
server.listen(PORT, () => {
  // #region agent log
  _dbg({ location: 'server.js:listenCb', message: 'Server listening', data: { port: PORT }, hypothesisId: 'A' });
  // #endregion
  console.log(`Server running on port ${PORT}`);
});
