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

// Generate license key with format: XXX-XXX-XXX
function generateLicenseKey(mentorPrefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let segment1 = '';
  let segment2 = '';
  
  for (let i = 0; i < 3; i++) {
    segment1 += chars.charAt(Math.floor(Math.random() * chars.length));
    segment2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return `${mentorPrefix}-${segment1}-${segment2}`;
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
    mentorId: MENTOR_ID,
    licensesCount: licenseKeys.length,
    signalsCount: signals.length
  });
});

// Generate new license key linked to EA (mentor only)
app.post('/generateLicense', async (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  const { ea_id, user_id } = req.body;

  if (!ea_id) {
    return res.status(400).json({ error: 'ea_id is required' });
  }

  try {
    // Generate unique key
    let licenseKey = generateLicenseKey(MENTOR_ID);
    
    // Check for collisions
    while (licenseKeys.find(l => l.key === licenseKey)) {
      licenseKey = generateLicenseKey(MENTOR_ID);
    }

    // Store license
    const newLicense = {
      key: licenseKey,
      ea_id: ea_id,
      user_id: user_id || null,
      active: true,
      createdAt: new Date().toISOString()
    };

    licenseKeys.push(newLicense);

    console.log(`🔑 New license generated: ${licenseKey} → EA: ${ea_id}`);

    res.json({ 
      success: true, 
      licenseKey: licenseKey,
      ea_id: ea_id,
      mentorId: MENTOR_ID,
      createdAt: newLicense.createdAt
    });

  } catch (error) {
    console.error('Error generating license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Validate license key
app.post('/validateLicense', (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.json({ valid: false, reason: 'License key is required' });
  }

  try {
    // Check format: XXX-XXX-XXX
    const regex = /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/;
    if (!regex.test(licenseKey)) {
      return res.json({ valid: false, reason: 'Invalid key format' });
    }

    // Check if key exists
    const license = licenseKeys.find(l => l.key === licenseKey);
    if (!license) {
      return res.json({ valid: false, reason: 'License key not found' });
    }

    if (!license.active) {
      return res.json({ valid: false, reason: 'License key is inactive' });
    }

    res.json({
      valid: true,
      reason: 'Valid license',
      license: {
        key: license.key,
        ea_id: license.ea_id,
        active: license.active,
        createdAt: license.createdAt
      }
    });

  } catch (error) {
    console.error('Error validating license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Receive signal from MT5 EA (mentor only)
app.post('/receiveSignal', (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  const { ea_id, type, symbol, entry_price, sl, tp, lot_size, comment } = req.body;

  // Validate required fields
  if (!ea_id || !type || !symbol || !sl || !tp) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['ea_id', 'type', 'symbol', 'sl', 'tp']
    });
  }

  try {
    // Create signal
    const newSignal = {
      id: Date.now().toString(),
      ea_id: ea_id,
      type: type.toUpperCase(),
      symbol: symbol.toUpperCase(),
      price: entry_price || null,
      sl: sl,
      tp: tp,
      lot_size: lot_size || null,
      comment: comment || null,
      timestamp: new Date().toISOString()
    };

    // Store signal (keep last 100)
    signals.unshift(newSignal);
    if (signals.length > 100) {
      signals = signals.slice(0, 100);
    }

    console.log(`📊 Signal received: ${type} ${symbol} @ ${entry_price} → EA: ${ea_id}`);

    // Broadcast to WebSocket clients
    broadcastSignal(newSignal);

    res.json({ 
      success: true, 
      signal_id: newSignal.id,
      ea_id: newSignal.ea_id,
      broadcasted: true
    });

  } catch (error) {
    console.error('Error processing signal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signals for specific EA
app.get('/signals/:ea_id', (req, res) => {
  const { ea_id } = req.params;

  try {
    const eaSignals = signals.filter(s => s.ea_id === ea_id);
    res.json({ signals: eaSignals });
  } catch (error) {
    console.error('Error fetching signals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all signals
app.get('/signals', (req, res) => {
  res.json({ signals });
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

  try {
    const license = licenseKeys.find(l => l.key === licenseKey);
    
    if (!license) {
      return res.status(404).json({ error: 'License key not found' });
    }

    license.active = false;

    console.log(`❌ License deactivated: ${licenseKey}`);

    res.json({ success: true, message: 'License deactivated' });

  } catch (error) {
    console.error('Error deactivating license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all licenses (mentor only)
app.get('/licenses', (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  res.json({ licenses: licenseKeys });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 EdgeFlow Backend running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🔑 Mentor ID: ${MENTOR_ID}`);
  console.log(`✅ Multi-mentor signal system ready (in-memory storage)`);
});
