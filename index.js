const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("EdgeFlow backend running");
});

// Receive signal (from MT5 / mentor)
app.post("/signal", (req, res) => {
  console.log("Signal received:", req.body);
  res.json({ status: "ok" });
});

// Return latest signals (for iOS web app)
let signals = [];

app.post("/send-signal", (req, res) => {
  const signal = { ...req.body, time: Date.now() };
  signals.unshift(signal);
  res.json({ success: true });
});

app.get("/signals", (req, res) => {
  res.json(signals.slice(0, 20));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
