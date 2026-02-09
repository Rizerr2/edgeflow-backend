// EdgeFlow Backend - Multi-Mentor Signal Broadcasting + MetaApi + Edge Functions
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const MetaApi = require('metaapi.cloud-sdk').default;

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
const SUPABASE_FUNCTIONS_URL = process.env.SUPABASE_FUNCTIONS_URL || 'https://kpytckomyhlznpokznlp.supabase.co/functions/v1';
const RAILWAY_SYNC_SECRET = process.env.RAILWAY_SYNC_SECRET;

console.log('🔑 Environment check:');
console.log('  METAAPI_TOKEN:', METAAPI_TOKEN ? '✅' : '❌');
console.log('  SUPABASE_FUNCTIONS_URL:', SUPABASE_FUNCTIONS_URL ? '✅' : '❌');
console.log('  RAILWAY_SYNC_SECRET:', RAILWAY_SYNC_SECRET ? '✅' : '❌');

// Initialize MetaApi
let metaApi = null;
if (METAAPI_TOKEN) {
  metaApi = new MetaApi(METAAPI_TOKEN);
  console.log('✅ MetaApi initialized');
} else {
  console.warn('⚠️ METAAPI_TOKEN not set');
}

// In-memory storage (for signals and students - licenses now in Supabase)
let signals = [];
let students = [];

// Helper: Call Edge Functions
async function callEdgeFunction(functionName, body) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': RAILWAY_SYNC_SECRET,
      },
      body: JSON.stringify(body),
    });
    
    const data = await res.json();
    return data;
  } catch (error) {
    console.error(`Edge Function ${functionName} error:`, error);
    return { error: error.message };
  }
}

// Helper: Validate Mentor ID via Edge Function
async function validateMentorId(mentorId) {
  const result = await callEdgeFunction('sync-mentor', {
    action: 'validate',
    mentor_id: mentorId,
  });
  
  if (result.valid && result.mentor) {
    console.log('✅ Mentor validated:', mentorId);
    return result.mentor;
  }
  
  console.log('❌ Mentor validation failed:', mentorId);
  return null;
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

// ============================
// HEALTH CHECK
// ============================
app.get('/health', async (req, res) => {
  const mentorsResult = await callEdgeFunction('sync-mentor', { action: 'list' });
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    mentorsCount: mentorsResult.count || 0,
    signalsCount: signals.length,
    studentsCount: students.length,
    metaApiEnabled: !!metaApi,
    supabaseBridge: !!RAILWAY_SYNC_SECRET
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

  const result = await callEdgeFunction('sync-mentor', {
    action: 'register',
    name,
    email,
    mentor_id,
  });

  if (result.error) {
    console.error('Mentor registration error:', result.error);
    return res.status(500).json(result);
  }

  console.log(`👨‍🏫 Mentor registered: ${name} (ID: ${result.mentor_id})`);
  res.json(result);
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

  const result = await callEdgeFunction('sync-license', {
    action: 'generate',
    mentor_id: mentorId,
    student_name: req.body.user_name || req.body.student_name,
    student_email: req.body.user_email || req.body.student_email,
    ea_id: req.body.ea_id,
    duration_days: req.body.duration_days || 30,
    plan_name: req.body.plan_name || 'Standard',
  });

  if (result.error) {
    console.error('License generation error:', result.error);
    return res.status(500).json(result);
  }

  console.log(`🔑 License generated: ${result.license_key}`);
  
  res.json({ 
    success: true, 
    licenseKey: result.license_key,
    ea_id: req.body.ea_id,
    mentorId: mentorId,
    createdAt: new Date().toISOString()
  });
});

app.post('/validateLicense', async (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.json({ valid: false, reason: 'License key is required' });
  }

  const result = await callEdgeFunction('sync-license', {
    action: 'validate',
    license_key: licenseKey,
  });

  if (!result.valid) {
    return res.json({ 
      valid: false, 
      reason: result.error || 'Invalid license key'
    });
  }

  res.json({
    valid: true,
    reason: 'Valid license',
    license: result.license,
    ea: result.ea,
    mentor: result.mentor
  });
});

app.post('/deactivateLicense', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Unauthorized - Invalid Mentor ID' });
  }

  const { licenseKey } = req.body;
  
  // For now, just return success - implement deactivation in Edge Function later
  res.json({ success: true, licenseKey: licenseKey });
});

app.get('/licenses', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  const mentor = await validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Unauthorized - Invalid Mentor ID' });
  }

  const result = await callEdgeFunction('sync-license', {
    action: 'status',
    mentor_id: mentorId,
  });
  
  res.json({ licenses: result.licenses || [] });
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

  // Validate license via Edge Function
  const licenseResult = await callEdgeFunction('sync-license', {
    action: 'validate',
    license_key: license_key,
  });

  if (!licenseResult.valid) {
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
      ea_id: licenseResult.license.ea_id,
      mentor_id: licenseResult.mentor?.mentor_id || 'unknown',
      metaapi_account_id: account.id,
      status: 'active',
      registered_at: new Date().toISOString(),
      vps_status: {
        mt5_connected: true,
        last_heartbeat: new Date().toISOString()
      }
    };

    students.push(student);
    console.log(`👤 Student registered: ${license_key}`);

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
  console.log(`✅ Supabase Bridge: ${RAILWAY_SYNC_SECRET ? 'ENABLED' : 'DISABLED'}`);
  console.log('════════════════════════════════════════');
});
