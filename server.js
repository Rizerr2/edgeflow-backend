// EdgeFlow Backend - Multi-Mentor Signal Broadcasting System (Simplified)
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.set('trust proxy', 1);
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// Environment variables
const MENTOR_TOKEN = process.env.MENTOR_TOKEN || 'default-secret-change-me';
const MENTOR_ID = process.env.MENTOR_ID || 'EDF';

// In-memory storage
let licenseKeys = []; // {key, ea_id, user_id, active, createdAt}
let signals = []; // {id, ea_id, type, symbol, price, sl, tp, lot_size, comment, timestamp}

// Create HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('✅ New WebSocket client connected');
  clients.add(ws);

  // Send recent signals to new client
  ws.send(JSON.stringify({ 
    type: 'initial', 
    signals: signals.slice(0, 20) // Last 20 signals
  }));

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
  let broadcastCount = 0;
  
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
      broadcastCount++;
    }
  });
  
  console.log(`📡 Signal broadcasted to ${broadcastCount} clients`);
}

// Generate license key with format: X
