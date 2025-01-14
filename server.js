require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });

const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  timestamp: { type: Date, default: Date.now },
});

const Message = mongoose.model("Message", messageSchema);

const sessions = new Map();
const socketToSession = new Map();

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

app.use(express.static("public"));

app.post("/session", (req, res) => {
  try {
    const sessionToken = generateSessionToken();
    res.json({ sessionToken });
  } catch (error) {
    console.error("Error generating session token:", error);
    res.status(500).json({ error: "Failed to generate session token" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/messages", async (req, res) => {
  const messages = await Message.find().sort({ timestamp: -1 });
  res.json(messages);
});

app.delete("/messages/clear", async (req, res) => {
  await Message.deleteMany({});
  io.emit("messagesCleared");
  res.status(200).send("All messages cleared");
});

io.on("connection", (socket) => {
  console.log("New connection attempt:", socket.id);

  socket.on("userJoined", async (userData) => {
    const { name, avatar, sessionToken } = userData;

    if (!sessionToken) {
      socket.emit("forceDisconnect", "Invalid session");
      socket.disconnect(true);
      return;
    }

    if (sessions.has(sessionToken)) {
      const existingSession = sessions.get(sessionToken);
      const existingSocket = io.sockets.sockets.get(existingSession.socketId);
      if (existingSocket) {
        existingSocket.emit(
          "forceDisconnect",
          "New session started from another tab/window"
        );
        existingSocket.disconnect(true);
      }
      socketToSession.delete(existingSession.socketId);
    }

    const sessionData = {
      socketId: socket.id,
      username: name,
      avatar: avatar,
      lastActive: Date.now(),
    };

    sessions.set(sessionToken, sessionData);
    socketToSession.set(socket.id, sessionToken);

    const onlineUsers = Array.from(sessions.values()).map((session) => ({
      id: session.socketId,
      name: session.username,
      avatar: session.avatar,
    }));

    io.emit("updateOnlineUsers", onlineUsers);
  });

  socket.on("sendMessage", async (data) => {
    const sessionToken = socketToSession.get(socket.id);
    const session = sessionToken ? sessions.get(sessionToken) : null;

    if (!session) {
      socket.emit("forceDisconnect", "Invalid session");
      socket.disconnect(true);
      return;
    }

    session.lastActive = Date.now();

    const { user, text } = data;
    const newMessage = new Message({ user, text });
    await newMessage.save();
    io.emit("newMessage", newMessage);
  });

  socket.on("clearMessages", async () => {
    const sessionToken = socketToSession.get(socket.id);
    if (!sessions.has(sessionToken)) {
      socket.emit("forceDisconnect", "Invalid session");
      socket.disconnect(true);
      return;
    }

    await Message.deleteMany({});
    io.emit("messagesCleared");
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);

    const sessionToken = socketToSession.get(socket.id);
    if (sessionToken) {
      sessions.delete(sessionToken);
      socketToSession.delete(socket.id);

      const onlineUsers = Array.from(sessions.values()).map((session) => ({
        id: session.socketId,
        name: session.username,
        avatar: session.avatar,
      }));

      io.emit("updateOnlineUsers", onlineUsers);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, sessionToken) => {
    if (now - session.lastActive > 30 * 60 * 1000) {
      sessions.delete(sessionToken);
      socketToSession.delete(session.socketId);
    }
  });
}, 60 * 1000);

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
