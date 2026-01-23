const express = require("express")
const cors = require("cors")
const http = require("http")
const { Server } = require("socket.io")

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "*"
  }
})

let signals = []

// Health check
app.get("/", (req, res) => {
  res.send("EdgeFlow backend running")
})

// Receive signal from EA / mentor
app.post("/signal", (req, res) => {
  const signal = { ...req.body, time: Date.now() }
  signals.unshift(signal)

  // 🔥 Broadcast to all connected users
  io.emit("signal", signal)

  res.json({ success: true })
})

// Get last signals (backup / reload)
app.get("/signals", (req, res) => {
  res.json(signals.slice(0, 20))
})

// WebSocket connection
io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  socket.emit("connected", {
    message: "Connected to EdgeFlow"
  })

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log("EdgeFlow server running on port", PORT)
})
