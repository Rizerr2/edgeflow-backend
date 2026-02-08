// EdgeFlow Backend - Multi-Mentor Signal Broadcasting + MetaApi + Supabase Storage
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const MetaApi = require('metaapi.cloud-sdk').default;
const { createClient } = require('@supabase/supabase-js');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.set('trust proxy', 1);
app.use(express.json());

// Rate limiting with VPS exemption
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
});

app.use((req, res, next) => {
  if (req.path.startsWith('/vps/') || req.path === '/signals') {
    return next();
  }
  limiter(req, res, next);
});

// Environment variables
const VPS_API_KEY = process.env.VPS_API_KEY || 'vps-secret-key-change-me';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin-super-secret-key-123';
const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('🔑 Environment check:');
console.log('  VPS_API_KEY:', VPS_API_KEY ? '✅' : '❌');
console.log('  METAAPI_TOKEN:', METAAPI_TOKEN ? '✅' : '❌');
console.log('  SUPABASE_URL:', SUPABASE_URL ? '✅' : '❌');
console.log('  SUPABASE_SERVICE_KEY:', SUPABASE_SERVICE_KEY ? '✅' : '❌');

// Initialize MetaApi
let metaApi = null;
if (METAAPI_TOKEN) {
  metaApi = new MetaApi(METAAPI_TOKEN);
  console.log('✅ MetaApi initialized');
} else {
  console.warn('⚠️ METAAPI_TOKEN not set - student trade execution disabled');
}

// Initialize Supabase
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('✅ Supabase connected');
} else {
  console.warn('⚠️ Supabase not configured - mentor storage disabled');
}

// In-memory storage (for licenses, signals, students)
let licenseKeys = [];
let signals = [];
let students = [];

// Helper: Generate 5-digit Mentor ID
function generateMentorId() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// Helper: Validate Mentor ID from Supabase
async function validateMentorId(mentorId) {
  if (!supabase) {
    console.warn('⚠️ Supabase not available, validation failed');
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('mentors')
      .select('*')
      .eq('mentor_id', mentorId)
      .eq('active', true)
      .single();
    
    if (error) {
      console.log('❌ Mentor validation error:', error.message);
      return null;
    }
    
    if (!data) {
      console.log('❌ Mentor not found:', mentorId);
      return null;
    }
    
    console.log('✅ Mentor validated:', mentorId);
    return data;
  } catch (error) {
    console.error('Error validating mentor:', error);
    return null;
  }
}

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

// Generate license key with mentor ID prefix
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
app.get('/health', async (req, res) => {
  let mentorsCount = 0;
  
  if (supabase) {
    try {
      const { count, error } = await supabase
        .from('mentors')
        .select('*', { count: 'exact', head: true });
      
      if (!error) {
        mentorsCount = count || 0;
      }
    } catch (error) {
      console.error('Error counting mentors:', error);
    }
  }

  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    mentorsCount: mentorsCount,
    licensesCount: licenseKeys.length,
    signalsCount: signals.length,
    studentsCount: students.length,
    metaApiEnabled: !!metaApi,
    supabaseConnected: !!supabase
  });
});

// ============================
// MENTOR REGISTRATION
// ============================
app.post('/mentor/register', async (req, res) => {
  const { name, email, mentor_id } = req.body;

  if (!name || !email) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['name', 'email']
    });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    // Check if mentor already exists
    const { data: existing, error: existError } = await supabase
      .from('mentors')
      .select('mentor_id')
      .eq('email', email)
      .maybeSingle();
    
    if (existing) {
      console.log('👨‍🏫 Mentor already registered:', existing.mentor_id);
      return res.json({ 
        success: true,
        already_registered: true,
        mentor_id: existing.mentor_id
      });
    }

    // Generate mentor ID if not provided
    let mentorIdGenerated = mentor_id || generateMentorId();
    
    // Check if ID is taken
    let { data: idCheck } = await supabase
      .from('mentors')
      .select('mentor_id')
      .eq('mentor_id', mentorIdGenerated)
      .maybeSingle();
    
    // Keep generating until unique
    while (idCheck) {
      mentorIdGenerated = generateMentorId();
      const result = await supabase
        .from('mentors')
        .select('mentor_id')
        .eq('mentor_id', mentorIdGenerated)
        .maybeSingle();
      idCheck = result.data;
    }

    // Insert new mentor
    const { error: insertError } = await supabase
      .from('mentors')
      .insert({
        mentor_id: mentorIdGenerated,
        name: name,
        email: email,
        active: true
      });

    if (insertError) {
      console.error('Insert error:', insertError);
      throw insertError;
    }

    console.log(`👨‍🏫 Mentor registered: ${name} (ID: ${mentorIdGenerated})`);

    res.json({
      success: true,
      mentor_id: mentorIdGenerated,
      message: 'Mentor registered successfully'
    });
  } catch (error) {
    console.error('Mentor registration error:', error);
    res.status(500).json({ 
      error: 'Registration failed',
      details: error.message 
    });
  }
});

app.get('/mentor/verify', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  
  if (!mentorId) {
    return res.status(401).json({ error: 'No Mentor ID provided' });
  }

  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Invalid Mentor ID' });
  }

  res.json({
    valid: true,
    mentor: {
      mentor_id: mentor.mentor_id,
      name: mentor.name,
      email: mentor.email,
      created_at: mentor.created_at
    }
  });
});

// ============================
// LICENSE MANAGEMENT
// ============================
app.post('/generateLicense', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  
  console.log('🔍 License generation request - Mentor ID:', mentorId);
  
  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    console.log('❌ Invalid Mentor ID:', mentorId);
    return res.status(401).json({ error: 'Unauthorized - Invalid Mentor ID' });
  }

  const { ea_id, user_id } = req.body;
  if (!ea_id) {
    return res.status(400).json({ error: 'ea_id is required' });
  }

  try {
    let licenseKey = generateLicenseKey(mentor.mentor_id);
    while (licenseKeys.find(l => l.key === licenseKey)) {
      licenseKey = generateLicenseKey(mentor.mentor_id);
    }

    const newLicense = {
      key: licenseKey,
      ea_id: ea_id,
      user_id: user_id || null,
      mentor_id: mentor.mentor_id,
      active: true,
      createdAt: new Date().toISOString()
    };

    licenseKeys.push(newLicense);
    console.log(`🔑 License generated: ${licenseKey} → EA: ${ea_id} → Mentor: ${mentor.mentor_id}`);

    res.json({ 
      success: true, 
      licenseKey: licenseKey,
      ea_id: ea_id,
      mentorId: mentor.mentor_id,
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

  const regex = /^[0-9]{5}-[A-Z0-9]{3}-[A-Z0-9]{3}$/;
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
      mentor_id: license.mentor_id,
      active: license.active,
      createdAt: license.createdAt
    }
  });
});

app.post('/deactivateLicense', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Unauthorized - Invalid Mentor ID' });
  }

  const { licenseKey } = req.body;
  const license = licenseKeys.find(l => l.key === licenseKey);
  
  if (!license) {
    return res.status(404).json({ error: 'License not found' });
  }

  if (license.mentor_id !== mentor.mentor_id) {
    return res.status(403).json({ error: 'Not authorized for this license' });
  }

  license.active = false;
  res.json({ success: true, licenseKey: licenseKey });
});

app.get('/licenses', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Unauthorized - Invalid Mentor ID' });
  }

  const mentorLicenses = licenseKeys.filter(l => l.mentor_id === mentor.mentor_id);
  
  res.json({ licenses: mentorLicenses });
});

// ============================
// SIGNAL MANAGEMENT
// ============================
app.post('/receiveSignal', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Unauthorized - Invalid Mentor ID' });
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
      mentor_id: mentor.mentor_id,
      type: type.toUpperCase(),
      symbol: symbol.toUpperCase(),
      price: entry_price || null,
      sl: sl,
      tp: tp,
      lot_size: lot_size || 0.01,
      comment: comment || null,
      timestamp: new Date().toISOString()
    };

    signals.unshift(newSignal);
    if (signals.length > 100) {
      signals = signals.slice(0, 100);
    }

    console.log(`📊 Signal: ${type} ${symbol} @ ${entry_price} → EA: ${ea_id} → Mentor: ${mentor.mentor_id}`);
    broadcastSignal(newSignal);

    // Execute on students via MetaApi
    if (metaApi) {
      const mentorStudents = students.filter(s => 
        s.mentor_id === mentor.mentor_id && s.status === 'active' && s.metaapi_account_id
      );

      console.log(`👥 Executing for ${mentorStudents.length} students...`);

      for (const student of mentorStudents) {
        try {
          const accountApi = metaApi.metatraderAccountApi;
          const account = await accountApi.getAccount(student.metaapi_account_id);
          await account.waitConnected(5000);

          const lotSize = lot_size || 0.01;

          if (type.toUpperCase() === 'BUY') {
            await account.createMarketBuyOrder(symbol, lotSize, sl, tp, {
              comment: comment || 'EdgeFlow Copy'
            });
          } else {
            await account.createMarketSellOrder(symbol, lotSize, sl, tp, {
              comment: comment || 'EdgeFlow Copy'
            });
          }
          
          console.log(`✅ Trade executed for ${student.license_key}`);
        } catch (error) {
          console.error(`❌ Failed for ${student.license_key}:`, error.message);
        }
      }
    }

    res.json({ 
      success: true, 
      signal_id: newSignal.id,
      ea_id: newSignal.ea_id,
      mentor_id: mentor.mentor_id,
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
app.post('/student/register', async (req, res) => {
  const { license_key, account_number, password, server, broker } = req.body;

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

  if (!metaApi) {
    return res.status(500).json({ error: 'MetaApi not configured. Contact admin.' });
  }

  try {
    console.log(`📝 Creating MetaApi account for ${license_key}...`);
    
    const accountApi = metaApi.metatraderAccountApi;
    const account = await accountApi.createAccount({
      name: `Student-${license_key}`,
      type: 'cloud',
      login: account_number,
      password: password,
      server: server,
      platform: 'mt5',
      application: 'MetaApi',
      magic: 0
    });

    console.log(`✅ MetaApi account created: ${account.id}`);
    await account.deploy();
    console.log(`🚀 Account deployed, waiting for connection...`);
    
    await account.waitConnected(60000);
    console.log(`✅ MT5 connected successfully`);

    const student = {
      license_key,
      account_number,
      server,
      broker: broker || 'Unknown',
      ea_id: license.ea_id,
      mentor_id: license.mentor_id,
      metaapi_account_id: account.id,
      status: 'active',
      registered_at: new Date().toISOString(),
      vps_status: {
        mt5_connected: true,
        last_heartbeat: new Date().toISOString()
      }
    };

    students.push(student);
    console.log(`👤 Student registered: ${license_key} → Mentor: ${license.mentor_id}`);

    res.json({
      success: true,
      message: 'Student registered successfully',
      license_key: license_key,
      status: 'active',
      mt5_connected: true
    });

  } catch (error) {
    console.error('❌ MetaApi registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect MT5 account',
      details: error.message,
      hint: 'Check your account number, password, and server name'
    });
  }
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
    registered_at: student.registered_at,
    vps_connected: vps_connected || (student.metaapi_account_id ? true : false),
    last_heartbeat: student.vps_status?.last_heartbeat || new Date().toISOString(),
    metaapi_enabled: !!student.metaapi_account_id
  });
});

// ============================
// VPS MANAGEMENT (Legacy)
// ============================
app.get('/vps/students', (req, res) => {
  const apiKey = req.headers['x-vps-api-key'];
  
  if (apiKey !== VPS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
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
  console.log('════════════════════════════════════════');
  console.log('🚀 EdgeFlow Backend Started');
  console.log('════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`✅ Multi-mentor: ENABLED`);
  console.log(`✅ MetaApi: ${metaApi ? 'ENABLED' : 'DISABLED'}`);
  console.log(`✅ Supabase: ${supabase ? 'ENABLED' : 'DISABLED'}`);
  console.log('════════════════════════════════════════');
});
