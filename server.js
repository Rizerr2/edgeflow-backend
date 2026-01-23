require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { pool, initDb } = require("./db");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// --- helpers
function requireMentorKey(req, res, next) {
  const key = req.header("x-mentor-key");
  if (!process.env.MENTOR_API_KEY) {
    return res.status(500).json({ ok: false, error: "MENTOR_API_KEY not set" });
  }
  if (!key || key !== process.env.MENTOR_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// --- health
app.get("/", (req, res) => res.json({ ok: true, service: "edgeflow-backend" }));
app.get("/health", (req, res) => res.json({ ok: true }));

// --- validate license (MT5 calls this)
app.post("/validateLicense", async (req, res) => {
  try {
    const { licenseKey } = req.body || {};
    if (!licenseKey) return res.status(400).json({ ok: false, error: "licenseKey required" });

    const r = await pool.query(
      "select license_key, is_active from licenses where license_key = $1",
      [licenseKey]
    );

    if (r.rowCount === 0) return res.status(200).json({ ok: false, valid: false });
    const row = r.rows[0];
    return res.status(200).json({ ok: true, valid: !!row.is_active });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- mentor creates a license (optional admin endpoint)
app.post("/admin/createLicense", requireMentorKey, async (req, res) => {
  try {
    const { licenseKey } = req.body || {};
    if (!licenseKey) return res.status(400).json({ ok: false, error: "licenseKey required" });

    await pool.query(
      "insert into licenses (license_key, is_active) values ($1, true) on conflict (license_key) do nothing",
      [licenseKey]
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- mentor sends signal (MT5 web app listens)
app.post("/sendSignal", requireMentorKey, async (req, res) => {
  try {
    const { licenseKey, signal } = req.body || {};
    if (!licenseKey) return res.status(400).json({ ok: false, error: "licenseKey required" });
    if (!signal) return res.status(400).json({ ok: false, error: "signal required" });

    // check license active
    const lr = await pool.query(
      "select is_active from licenses where license_key = $1",
      [licenseKey]
    );
    if (lr.rowCount === 0 || !lr.rows[0].is_active) {
      return res.status(403).json({ ok: false, error: "invalid_license" });
    }

    const payload = { ...signal, ts: Date.now() };

    await pool.query(
      "insert into signals (license_key, payload) values ($1, $2)",
      [licenseKey, payload]
    );

    // wake any SSE listeners
    broadcastToSse(licenseKey, payload);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- ios web app realtime: SSE stream (super simple)
const sseClients = new Map(); // licenseKey -> Set(res)

function addSseClient(licenseKey, res) {
  if (!sseClients.has(licenseKey)) sseClients.set(licenseKey, new Set());
  sseClients.get(licenseKey).add(res);
}

function removeSseClient(licenseKey, res) {
  const set = sseClients.get(licenseKey);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(licenseKey);
}

function broadcastToSse(licenseKey, payload) {
  const set = sseClients.get(licenseKey);
  if (!set) return;
  const msg = `event: signal\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(msg);
}

// client connects: /stream?licenseKey=XXXX
app.get("/stream", async (req, res) => {
  const licenseKey = String(req.query.licenseKey || "");
  if (!licenseKey) return res.status(400).send("licenseKey required");

  // validate active
  const lr = await pool.query("select is_active from licenses where license_key = $1", [licenseKey]);
  if (lr.rowCount === 0 || !lr.rows[0].is_active) return res.status(403).send("invalid_license");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  addSseClient(licenseKey, res);

  req.on("close", () => {
    removeSseClient(licenseKey, res);
  });
});

// --- start
(async () => {
  await initDb();
  app.listen(PORT, () => console.log("edgeflow backend listening on", PORT));
})();
