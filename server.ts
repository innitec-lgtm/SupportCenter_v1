import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createServer as createViteServer } from "vite";
import { kv } from "@vercel/kv";
import { Ticket, Engineer, Contact } from "./types";
import { DEFAULT_CONTACTS, DEFAULT_ENGINEERS } from "./constants";

const DATA_DIR = path.join(process.cwd(), "data");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const ENGINEERS_FILE = path.join(DATA_DIR, "engineers.json");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Check if Vercel KV is configured
const isKVConfigured = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;

async function getData<T>(key: string, filePath: string, defaultValue: T): Promise<T> {
  if (isKVConfigured) {
    try {
      const data = await kv.get<T>(key);
      if (data) return data;
    } catch (e) {
      console.error(`Failed to get ${key} from Vercel KV`, e);
    }
  }
  
  // Fallback to local file
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      console.error(`Failed to load ${filePath}`, e);
    }
  }
  return defaultValue;
}

async function setData(key: string, filePath: string, data: any) {
  if (isKVConfigured) {
    try {
      await kv.set(key, data);
    } catch (e) {
      console.error(`Failed to set ${key} in Vercel KV`, e);
    }
  }
  
  // Always write to local file as well (if possible)
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    // In some environments (like Vercel production), this might fail, which is expected
    if (!isKVConfigured) console.error(`Failed to save ${filePath}`, e);
  }
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Force no-cache for all requests
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  });

  // API Routes
  app.get("/api/tickets", async (req, res) => {
    const tickets = await getData<Ticket[]>("tickets", TICKETS_FILE, []);
    res.json(tickets);
  });

  app.post("/api/tickets", async (req, res) => {
    const ticket = req.body;
    let tickets = await getData<Ticket[]>("tickets", TICKETS_FILE, []);
    tickets.push(ticket);
    await setData("tickets", TICKETS_FILE, tickets);
    io.emit("tickets:updated", tickets);
    res.status(201).json(ticket);
  });

  app.put("/api/tickets/:id", async (req, res) => {
    const { id } = req.params;
    const updatedTicket = req.body;
    let tickets = await getData<Ticket[]>("tickets", TICKETS_FILE, []);
    tickets = tickets.map(t => t.id === id ? updatedTicket : t);
    await setData("tickets", TICKETS_FILE, tickets);
    io.emit("tickets:updated", tickets);
    res.json(updatedTicket);
  });

  app.delete("/api/tickets/:id", async (req, res) => {
    const { id } = req.params;
    let tickets = await getData<Ticket[]>("tickets", TICKETS_FILE, []);
    tickets = tickets.filter(t => t.id !== id);
    await setData("tickets", TICKETS_FILE, tickets);
    io.emit("tickets:updated", tickets);
    res.status(204).send();
  });

  app.get("/api/engineers", async (req, res) => {
    const engineers = await getData<Engineer[]>("engineers", ENGINEERS_FILE, [...DEFAULT_ENGINEERS]);
    res.json(engineers);
  });

  app.post("/api/engineers", async (req, res) => {
    const engineers = req.body;
    await setData("engineers", ENGINEERS_FILE, engineers);
    io.emit("engineers:updated", engineers);
    res.json(engineers);
  });

  app.get("/api/contacts", async (req, res) => {
    const contacts = await getData<Contact[]>("contacts", CONTACTS_FILE, [...DEFAULT_CONTACTS]);
    res.json(contacts);
  });

  app.post("/api/contacts", async (req, res) => {
    const contacts = req.body;
    await setData("contacts", CONTACTS_FILE, contacts);
    io.emit("contacts:updated", contacts);
    res.json(contacts);
  });

  app.get("/api/config", (req, res) => {
    res.json({
      appUrl: process.env.APP_URL || "",
      sharedAppUrl: process.env.SHARED_APP_URL || "",
      version: "2.6.0",
      kvEnabled: isKVConfigured,
      env: process.env.NODE_ENV || "development",
      timestamp: new Date().getTime()
    });
  });

  app.get("/status", (req, res) => {
    res.json({
      status: "online",
      version: "2.6.0",
      kvEnabled: isKVConfigured,
      time: new Date().toISOString()
    });
  });

  // Always use Vite middleware in this environment
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);

  // Socket.io connection
  io.on("connection", async (socket) => {
    console.log("User connected:", socket.id);
    
    // Send initial state
    const tickets = await getData<Ticket[]>("tickets", TICKETS_FILE, []);
    const engineers = await getData<Engineer[]>("engineers", ENGINEERS_FILE, [...DEFAULT_ENGINEERS]);
    const contacts = await getData<Contact[]>("contacts", CONTACTS_FILE, [...DEFAULT_CONTACTS]);
    
    socket.emit("tickets:updated", tickets);
    socket.emit("engineers:updated", engineers);
    socket.emit("contacts:updated", contacts);

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
