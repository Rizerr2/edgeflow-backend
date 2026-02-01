// EdgeFlow Backend - Multi-Mentor Signal Broadcasting + Student Management + VPS Heartbeat
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
const VPS_API_KEY = process.env.VPS_API_KEY || 'vps-secret-key-change-me';
console.log('🔑 VPS_API_KEY loaded:', VPS_API_KEY);

// In-memory storage
let licenseKeys = [];
let signals = [];
let students = [];

// Create HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('✅ New WebSocket client connected');
  clients.add(ws);
  
  ws.send(JSON.stringify({ 
    type: 'initial', 
    signals: signals.slice(0, 20)
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

// Broadcast signal
function broadcastSignal(signal) {
  const message = JSON.stringify({ type: 'signal', data: signal });
  let broadcastCount = 0;
  
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
      broadcastCount++;
    }
  });
  
  console.log(`📡 Broadcasted to ${broadcastCount} clients`);
}

// Generate license key
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
// HEALTH CHECK
// ============================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    mentorId: MENTOR_ID,
    licensesCount: licenseKeys.length,
    signalsCount: signals.length,
    studentsCount: students.length
  });
});

// ============================
// LICENSE MANAGEMENT
// ============================
app.post('/generateLicense', async (req, res) => {
  const token = req.headers['x-mentor-token'];
  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { ea_id, user_id } = req.body;
  if (!ea_id) {
    return res.status(400).json({ error: 'ea_id is required' });
  }

  try {
    let licenseKey = generateLicenseKey(MENTOR_ID);
    while (licenseKeys.find(l => l.key === licenseKey)) {
      licenseKey = generateLicenseKey(MENTOR_ID);
    }

    const newLicense = {
      key: licenseKey,
      ea_id: ea_id,
      user_id: user_id || null,
      active: true,
      createdAt: new Date().toISOString()
    };

    licenseKeys.push(newLicense);
    console.log(`🔑 License generated: ${licenseKey} → EA: ${ea_id}`);

    res.json({ 
      success: true, 
      licenseKey: licenseKey,
      ea_id: ea_id,
      mentorId: MENTOR_ID,
      createdAt: newLicense.createdAt
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/validateLicense', (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.json({ valid: false, reason: 'License key is required' });
  }

  const regex = /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/;
  if (!regex.test(licenseKey)) {
    return res.json({ valid: false, reason: 'Invalid key format' });
  }

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
});

app.post('/deactivateLicense', (req, res) => {
  const token = req.headers['x-mentor-token'];
  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { licenseKey } = req.body;
  const license = licenseKeys.find(l => l.key === licenseKey);
  
  if (!license) {
    return res.status(404).json({ error: 'License not found' });
  }

  license.active = false;
  res.json({ success: true, licenseKey: licenseKey });
});

app.get('/licenses', (req, res) => {
  const token = req.headers['x-mentor-token'];
  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ licenses: licenseKeys });
});

// ============================
// SIGNAL MANAGEMENT
// ============================
app.post('/receiveSignal', (req, res) => {
  const token = req.headers['x-mentor-token'];
  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { ea_id, type, symbol, entry_price, sl, tp, lot_size, comment } = req.body;

  if (!ea_id || !type || !symbol || !sl || !tp) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['ea_id', 'type', 'symbol', 'sl', 'tp']
    });
  }

  try {
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

    signals.unshift(newSignal);
    if (signals.length > 100) {
      signals = signals.slice(0, 100);
    }

    console.log(`📊 Signal: ${type} ${symbol} @ ${entry_price} → EA: ${ea_id}`);
    broadcastSignal(newSignal);

    res.json({ 
      success: true, 
      signal_id: newSignal.id,
      ea_id: newSignal.ea_id,
      broadcasted: true
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/signals/:ea_id', (req, res) => {
  const { ea_id } = req.params;
  const eaSignals = signals.filter(s => s.ea_id === ea_id);
  res.json({ signals: eaSignals });
});

app.get('/signals', (req, res) => {
  res.json({ signals });
});

// ============================
// STUDENT MANAGEMENT
// ============================
app.post('/student/register', (req, res) => {
  const { 
    license_key, 
    account_number, 
    password, 
    server, 
    broker,
    lot_multiplier 
  } = req.body;

  if (!license_key || !account_number || !password || !server) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['license_key', 'account_number', 'password', 'server']
    });
  }

  const license = licenseKeys.find(l => l.key === license_key && l.active);
  if (!license) {
    return res.status(403).json({ error: 'Invalid or inactive license key' });
  }

  const existing = students.find(s => s.license_key === license_key);
  if (existing) {
    return res.status(409).json({ error: 'License key already registered' });
  }

  const student = {
    license_key,
    account_number,
    password,
    server,
    broker: broker || 'Unknown',
    ea_id: license.ea_id,
    lot_multiplier: lot_multiplier || 1.0,
    status: 'pending',
    registered_at: new Date().toISOString(),
    vps_status: null
  };

  students.push(student);
  console.log(`👤 Student registered: ${license_key}`);

  res.json({
    success: true,
    message: 'Student registered successfully',
    license_key: license_key,
    status: 'pending'
  });
});

app.post('/student/start', (req, res) => {
  const { license_key } = req.body;

  if (!license_key) {
    return res.status(400).json({ error: 'license_key is required' });
  }

  const student = students.find(s => s.license_key === license_key);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  student.status = 'active';
  student.started_at = new Date().toISOString();

  console.log(`▶️ Copy trading started: ${license_key}`);

  res.json({
    success: true,
    message: 'Copy trading started',
    status: 'active'
  });
});

app.post('/student/stop', (req, res) => {
  const { license_key } = req.body;

  if (!license_key) {
    return res.status(400).json({ error: 'license_key is required' });
  }

  const student = students.find(s => s.license_key === license_key);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  student.status = 'stopped';
  student.stopped_at = new Date().toISOString();

  console.log(`⏸️ Copy trading stopped: ${license_key}`);

  res.json({
    success: true,
    message: 'Copy trading stopped',
    status: 'stopped'
  });
});

app.get('/student/status/:license_key', (req, res) => {
  const { license_key } = req.params;
  
  const student = students.find(s => s.license_key === license_key);
  
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Check if VPS heartbeat is recent (< 60 seconds = connected)
  let vps_connected = false;
  if (student.vps_status && student.vps_status.last_heartbeat) {
    const lastHeartbeat = new Date(student.vps_status.last_heartbeat);
    const now = new Date();
    const diffSeconds = (now - lastHeartbeat) / 1000;
    vps_connected = diffSeconds < 60 && student.vps_status.mt5_connected;
  }

  res.json({
    license_key: student.license_key,
    status: student.status,
    broker: student.broker,
    server: student.server,
    account_number: student.account_number,
    lot_multiplier: student.lot_multiplier,
    registered_at: student.registered_at,
    vps_connected: vps_connected,
    last_heartbeat: student.vps_status?.last_heartbeat || null
  });
});

// ============================
// VPS MANAGEMENT
// ============================
app.get('/vps/students', (req, res) => {
  const apiKey = req.headers['x-vps-api-key'];
  
  console.log('=== VPS STUDENTS DEBUG ===');
  console.log('Received headers:', JSON.stringify(req.headers));
  console.log('Received API Key:', apiKey);
  console.log('Expected API Key:', VPS_API_KEY);
  console.log('Match:', apiKey === VPS_API_KEY);
  
  if (apiKey !== VPS_API_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      debug: {
        received: apiKey,
        expected: VPS_API_KEY,
        receivedLength: apiKey ? apiKey.length : 0,
        expectedLength: VPS_API_KEY.length
      }
    });
  }

  const activeStudents = students.filter(s => s.status === 'active');
  
  res.json({
    students: activeStudents,
    count: activeStudents.length
  });
});

app.post('/vps/heartbeat', (req, res) => {
  const apiKey = req.headers['x-vps-api-key'];
  
  if (apiKey !== VPS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { license_key, mt5_connected } = req.body;

  const student = students.find(s => s.license_key === license_key);
  
  if (student) {
    student.vps_status = {
      mt5_connected: mt5_connected,
      last_heartbeat: new Date().toISOString()
    };
    
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Student not found' });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 EdgeFlow Backend running on port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`🔑 Mentor ID: ${MENTOR_ID}`);
  console.log(`✅ VPS heartbeat enabled`);
});
