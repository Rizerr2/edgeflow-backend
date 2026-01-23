// EdgeFlow Backend - License Validation & Signal Broadcasting
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allow all origins
app.use(express.json()); // Parse JSON request bodies

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // Max 100 requests per 15 minutes per IP
});
app.use(limiter);

// In-memory storage
let signals = []; // Signal objects
let generatedLicenses = []; // Generated license keys: {key, mentorId, createdAt, active}

// Environment variables
const MENTOR_TOKEN = process.env.MENTOR_TOKEN || 'default-secret-change-me';
const SECRET_KEY = process.env.SECRET_KEY || 'default-secret-key';
const MENTOR_ID = process.env.MENTOR_ID || 'EDF';

// Create HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });
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
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Generate license key with format: EDF-XXX-XXX
function generateLicenseKey() {
  // Generate random characters (uppercase + numbers)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let segment1 = '';
  let segment2 = '';
  
  for (let i = 0; i < 3; i++) {
    segment1 += chars.charAt(Math.floor(Math.random() * chars.length));
    segment2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return `${MENTOR_ID}-${segment1}-${segment2}`;
}

// Validate license key format and existence
function validateLicenseKey(key) {
  // Check format: XXX-XXX-XXX
  const regex = /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/;
  if (!regex.test(key)) {
    return { valid: false, reason: 'Invalid key format' };
  }

  // Check if key starts with correct mentor ID
  if (!key.startsWith(MENTOR_ID + '-')) {
    return { valid: false, reason: 'Invalid mentor ID in key' };
  }

  // Check if key exists in generated licenses
  const license = generatedLicenses.find(l => l.key === key);
  if (!license) {
    return { valid: false, reason: 'License key not found' };
  }

  // Check if license is active
  if (!license.active) {
    return { valid: false, reason: 'License key is inactive' };
  }

  return { valid: true, reason: 'Valid license', license };
}

// ============================
// ENDPOINTS
// ============================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    signalsCount: signals.length,
    licensesCount: generatedLicenses.length,
    mentorId: MENTOR_ID
  });
});

// Generate new license key (mentor only)
app.post('/generateLicense', (req, res) => {
  const token = req.headers['x-mentor-token'];

  // Verify mentor token
  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  // Generate unique key
  let key = generateLicenseKey();
  
  // Ensure uniqueness (very unlikely to collide, but check anyway)
  while (generatedLicenses.find(l => l.key === key)) {
    key = generateLicenseKey();
  }

  // Store license
  const license = {
    key,
    mentorId: MENTOR_ID,
    createdAt: new Date().toISOString(),
    active: true
  };

  generatedLicenses.push(license);

  console.log(`🔑 New license generated: ${key}`);

  res.json({ 
    success: true, 
    licenseKey: key,
    mentorId: MENTOR_ID,
    createdAt: license.createdAt
  });
});

// Validate license key
app.post('/validateLicense', (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.json({ valid: false, reason: 'License key is required' });
  }

  const result = validateLicenseKey(licenseKey);
  res.json(result);
});

// Deactivate license key (mentor only)
app.post('/deactivateLicense', (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.status(400).json({ error: 'License key is required' });
  }

  const license = generatedLicenses.find(l => l.key === licenseKey);
  
  if (!license) {
    return res.status(404).json({ error: 'License key not found' });
  }

  license.active = false;

  console.log(`❌ License deactivated: ${licenseKey}`);

  res.json({ success: true, message: 'License deactivated' });
});

// Get all generated licenses (mentor only)
app.get('/licenses', (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  res.json({ licenses: generatedLicenses });
});

// Send signal (mentor only)
app.post('/sendSignal', (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  const { title, message } = req.body;

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  const signal = {
    id: Date.now().toString(),
    title,
    message,
    timestamp: new Date().toISOString()
  };

  signals.unshift(signal);

  if (signals.length > 50) {
    signals = signals.slice(0, 50);
  }

  broadcastSignal(signal);

  console.log(`📡 Signal sent: ${title}`);

  res.json({ success: true, signal });
});

// Get all signals
app.get('/signals', (req, res) => {
  res.json({ signals });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 EdgeFlow Backend running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🔑 Mentor ID: ${MENTOR_ID}`);
  console.log(`✅ Ready to generate and validate licenses`);
});
