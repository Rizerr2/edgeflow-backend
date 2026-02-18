// EdgeFlow Backend - Simple Trade Signal Broadcasting + MetaApi
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const MetaApi = require('metaapi.cloud-sdk').default;

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

// Environment
const METAAPI_TOKEN = process.env.METAAPI_TOKEN;

console.log('🔑 METAAPI_TOKEN:', METAAPI_TOKEN ? '✅' : '❌');

// Initialize MetaApi
let metaApi = null;
if (METAAPI_TOKEN) {
  metaApi = new MetaApi(METAAPI_TOKEN);
  console.log('✅ MetaApi initialized');
}

// In-memory storage
let signals = [];
let students = [];
let mentors = [];

function generateMentorId() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

function validateMentorId(mentorId) {
  return mentors.find(m => m.mentor_id === mentorId && m.active);
}

// HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('✅ WebSocket connected');
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'initial', signals: signals.slice(0, 20) }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', (err) => clients.delete(ws));
});

function broadcastSignal(signal) {
  const message = JSON.stringify({ type: 'signal', data: signal });
  clients.forEach(c => c.readyState === 1 && c.send(message));
  console.log(`📡 Broadcasted to ${clients.size} clients`);
}

// ============================
// ENDPOINTS
// ============================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    mentorsCount: mentors.length,
    signalsCount: signals.length,
    studentsCount: students.length,
    metaApiEnabled: !!metaApi
  });
});

app.post('/mentor/register', (req, res) => {
  const { name, email, mentor_id } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Missing fields' });

  const existing = mentors.find(m => m.email === email);
  if (existing) {
    return res.json({ success: true, already_registered: true, mentor_id: existing.mentor_id });
  }

  let mentorIdGenerated = mentor_id || generateMentorId();
  while (mentors.find(m => m.mentor_id === mentorIdGenerated)) {
    mentorIdGenerated = generateMentorId();
  }

  mentors.push({
    mentor_id: mentorIdGenerated,
    name,
    email,
    active: true,
    created_at: new Date().toISOString()
  });

  console.log(`👨‍🏫 Mentor registered: ${name} (${mentorIdGenerated})`);
  res.json({ success: true, mentor_id: mentorIdGenerated });
});

app.post('/receiveSignal', async (req, res) => {
  const mentorId = req.headers['x-mentor-id'];
  const mentor = validateMentorId(mentorId);
  
  if (!mentor) {
    return res.status(401).json({ error: 'Invalid Mentor ID' });
  }

  const { ea_id, type, symbol, entry_price, sl, tp, lot_size, comment } = req.body;

  if (!type || !symbol || !sl || !tp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const newSignal = {
    id: Date.now().toString(),
    ea_id: ea_id || 'default',
    mentor_id: mentor.mentor_id,
    type: type.toUpperCase(),
    symbol: symbol.toUpperCase(),
    price: entry_price || null,
    sl, tp,
    lot_size: lot_size || 0.01,
    comment: comment || null,
    timestamp: new Date().toISOString()
  };

  signals.unshift(newSignal);
  if (signals.length > 100) signals = signals.slice(0, 100);

  console.log(`📊 Signal: ${type} ${symbol} @ ${entry_price} → Mentor: ${mentor.mentor_id}`);
  broadcastSignal(newSignal);

  // Execute on students
  if (metaApi) {
    const mentorStudents = students.filter(s => 
      s.mentor_id === mentor.mentor_id && s.status === 'active' && s.metaapi_account_id
    );

    console.log(`👥 Executing for ${mentorStudents.length} students...`);

    for (const student of mentorStudents) {
      try {
        const account = await metaApi.metatraderAccountApi.getAccount(student.metaapi_account_id);
        await account.waitConnected(5000);

        const lotSize = lot_size || 0.01;

        if (type.toUpperCase() === 'BUY') {
          await account.createMarketBuyOrder(symbol, lotSize, sl, tp, { comment: comment || 'EdgeFlow' });
        } else {
          await account.createMarketSellOrder(symbol, lotSize, sl, tp, { comment: comment || 'EdgeFlow' });
        }
        
        console.log(`✅ Trade executed for ${student.license_key}`);
      } catch (error) {
        console.error(`❌ Failed for ${student.license_key}:`, error.message);
      }
    }
  }

  res.json({ success: true, signal_id: newSignal.id, mentor_id: mentor.mentor_id, broadcasted: true });
});

app.get('/signals', (req, res) => res.json({ signals }));

app.post('/student/register', async (req, res) => {
  const { license_key, account_number, password, server, broker } = req.body;

  if (!license_key || !account_number || !password || !server) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const licenseRegex = /^\d{5}-[A-Z0-9]{8}$/i;
  if (!licenseRegex.test(license_key)) {
    return res.status(403).json({ error: 'Invalid license format' });
  }

  const mentor_id = license_key.split('-')[0];

  if (students.find(s => s.license_key === license_key)) {
    return res.status(409).json({ error: 'License already registered' });
  }

  if (!metaApi) {
    return res.status(500).json({ error: 'MetaApi not configured' });
  }

  try {
    console.log(`📝 Creating MetaApi account for ${license_key}...`);
    
    const account = await metaApi.metatraderAccountApi.createAccount({
      name: `Student-${license_key}`,
      type: 'cloud',
      login: account_number,
      password: password,
      server: server,
      platform: 'mt5',
      application: 'MetaApi',
      magic: 0
    });

    console.log(`✅ Created: ${account.id}`);
    await account.deploy();
    await account.waitConnected(60000);
    console.log(`✅ MT5 connected`);

    students.push({
      license_key,
      account_number,
      server,
      broker: broker || 'Unknown',
      mentor_id,
      metaapi_account_id: account.id,
      status: 'active',
      registered_at: new Date().toISOString()
    });

    console.log(`👤 Student registered: ${license_key}`);

    res.json({ success: true, license_key, status: 'active', mt5_connected: true });

  } catch (error) {
    console.error('❌ MetaApi error:', error);
    res.status(500).json({ error: 'Failed to connect MT5', details: error.message });
  }
});

app.post('/student/start', (req, res) => {
  const student = students.find(s => s.license_key === req.body.license_key);
  if (!student) return res.status(404).json({ error: 'Not found' });
  student.status = 'active';
  console.log(`▶️ Started: ${req.body.license_key}`);
  res.json({ success: true, status: 'active' });
});

app.post('/student/stop', (req, res) => {
  const student = students.find(s => s.license_key === req.body.license_key);
  if (!student) return res.status(404).json({ error: 'Not found' });
  student.status = 'stopped';
  console.log(`⏸️ Stopped: ${req.body.license_key}`);
  res.json({ success: true, status: 'stopped' });
});

// Start
server.listen(PORT, () => {
  console.log('════════════════════════════════════════');
  console.log('🚀 EdgeFlow Backend - SIMPLIFIED');
  console.log('════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`✅ MetaApi: ${metaApi ? 'ENABLED' : 'DISABLED'}`);
  console.log('════════════════════════════════════════');
});
