// EdgeFlow Backend - Multi-Mentor Signal Broadcasting System
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Create HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('✅ New WebSocket client connected');
  clients.add(ws);

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
    supabaseConnected: !!supabase
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
    
    // Check if key already exists in Supabase
    let { data: existing } = await supabase
      .from('license_keys')
      .select('license_key')
      .eq('license_key', licenseKey)
      .single();
    
    // Regenerate if collision (very rare)
    while (existing) {
      licenseKey = generateLicenseKey(MENTOR_ID);
      const check = await supabase
        .from('license_keys')
        .select('license_key')
        .eq('license_key', licenseKey)
        .single();
      existing = check.data;
    }

    // Insert into Supabase license_keys table
    const { data: newLicense, error: insertError } = await supabase
      .from('license_keys')
      .insert({
        license_key: licenseKey,
        ea_id: ea_id,
        user_id: user_id || null,
        is_active: true,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create license', details: insertError.message });
    }

    console.log(`🔑 New license generated: ${licenseKey} → EA: ${ea_id}`);

    res.json({ 
      success: true, 
      licenseKey: licenseKey,
      ea_id: ea_id,
      mentorId: MENTOR_ID,
      createdAt: newLicense.created_at
    });

  } catch (error) {
    console.error('Error generating license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Validate license key (checks Supabase)
app.post('/validateLicense', async (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.json({ valid: false, reason: 'License key is required' });
  }

  try {
    // Check in Supabase
    const { data: license, error } = await supabase
      .from('license_keys')
      .select('*, eas(id, name)')
      .eq('license_key', licenseKey)
      .single();

    if (error || !license) {
      return res.json({ valid: false, reason: 'License key not found' });
    }

    if (!license.is_active) {
      return res.json({ valid: false, reason: 'License key is inactive' });
    }

    res.json({
      valid: true,
      reason: 'Valid license',
      license: {
        key: license.license_key,
        ea_id: license.ea_id,
        ea_name: license.eas?.name,
        active: license.is_active,
        createdAt: license.created_at
      }
    });

  } catch (error) {
    console.error('Error validating license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Receive signal from MT5 EA (mentor only)
app.post('/receiveSignal', async (req, res) => {
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
    // Insert signal into Supabase signals table
    const { data: newSignal, error: insertError } = await supabase
      .from('signals')
      .insert({
        ea_id: ea_id,
        type: type.toUpperCase(),
        symbol: symbol.toUpperCase(),
        price: entry_price || null,
        sl: sl,
        tp: tp,
        lot_size: lot_size || null,
        comment: comment || null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('Supabase signal insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save signal', details: insertError.message });
    }

    console.log(`📊 Signal received: ${type} ${symbol} @ ${entry_price} → EA: ${ea_id}`);

    // Broadcast to WebSocket clients
    broadcastSignal({
      id: newSignal.id,
      ea_id: newSignal.ea_id,
      type: newSignal.type,
      symbol: newSignal.symbol,
      price: newSignal.price,
      sl: newSignal.sl,
      tp: newSignal.tp,
      lot_size: newSignal.lot_size,
      comment: newSignal.comment,
      timestamp: newSignal.created_at
    });

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

// Get signals for specific EA (optional - for testing)
app.get('/signals/:ea_id', async (req, res) => {
  const { ea_id } = req.params;

  try {
    const { data: signals, error } = await supabase
      .from('signals')
      .select('*')
      .eq('ea_id', ea_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ signals });

  } catch (error) {
    console.error('Error fetching signals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deactivate license key (mentor only)
app.post('/deactivateLicense', async (req, res) => {
  const token = req.headers['x-mentor-token'];

  if (token !== MENTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - invalid mentor token' });
  }

  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.status(400).json({ error: 'License key is required' });
  }

  try {
    const { error } = await supabase
      .from('license_keys')
      .update({ is_active: false })
      .eq('license_key', licenseKey);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    console.log(`❌ License deactivated: ${licenseKey}`);

    res.json({ success: true, message: 'License deactivated' });

  } catch (error) {
    console.error('Error deactivating license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 EdgeFlow Backend running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🔑 Mentor ID: ${MENTOR_ID}`);
  console.log(`💾 Supabase: ${SUPABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`✅ Multi-mentor signal system ready`);
});
