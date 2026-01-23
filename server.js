// EdgeFlow Backend - License Validation & Signal Broadcasting
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allow all origins (your lovable.dev app can connect)
app.use(express.json()); // Parse JSON request bodies

// Rate limiting - prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // Max 100 requests per 15 minutes per IP
});
app.use(limiter);

// In-memory storage (RAM) - data lost on restart, but works immediately
let signals = []; // Array of signal objects: {id, title, message, timestamp}

// Environment variables (set in Railway)
const MENTOR_TOKEN = process.env.MENTOR_TOKEN || 'default-secret-change-me';
const LICENSE_KEYS = (process.env.LICENSE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

// Create HTTP server (needed for WebSocket)
const server = http.createServer(app);

// WebSocket server for live signal broadcasting
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('✅ New WebSocket client connected');
  clients.add(ws);

  // Send current signals to new client
  ws.send(JSON.stringify({ type: 'initial', signals }));

  ws.on('close', () => {
    console.log('❌ Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

// Broadcast signal to all connected clients
function broadcastSignal(signal) {
  const message = JSON.stringify({ type: 'signal', data: signal });
  clients.forEach((client) => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(message);
    }
  });
}

// ============================
// ENDPOINTS
// ============================

// 1. Health check - verify server is running
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    signalsCount: signals.length
  });
});

// 2. Validate license key
app.post('/validateLicense', (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.json({ valid: false, reason: 'License key is required' });
  }

  // Check if key exists in allowed list
  const isValid = LICENSE_KEYS.includes(licenseKey);

  res.json({
    valid: isValid,
    reason: isValid ? 'Valid license' : 'Invalid license key'
  });
});

// 3. Send signal (mentor only - requires token)
app.post('/sendSignal', (req, res) => {
  const token = req.headers['x-mentor-token'];

  // Verify mentor token
  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  const { title, message } = req.body;

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  // Create signal object
  const signal = {
    id: Date.now().toString(),
    title,
    message,
    timestamp: new Date().toISOString()
  };

  // Store signal (in-memory)
  signals.unshift(signal); // Add to beginning of array

  // Keep only last 50 signals
  if (signals.length > 50) {
    signals = signals.slice(0, 50);
  }

  // Broadcast to all connected WebSocket clients
  broadcastSignal(signal);

  res.json({ success: true, signal });
});

// 4. Get all signals (latest first)
app.get('/signals', (req, res) => {
  res.json({ signals });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 EdgeFlow Backend running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🔑 Allowed license keys: ${LICENSE_KEYS.length} configured`);
});
