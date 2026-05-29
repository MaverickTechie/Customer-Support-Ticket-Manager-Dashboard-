/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// Shared ticket types matching frontend
enum TicketPriority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

enum TicketStatus {
  UNASSIGNED = "UNASSIGNED",
  ANALYZING = "ANALYZING",
  ACTIVE_ALERT = "ACTIVE_ALERT",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  RESOLVED = "RESOLVED",
}

interface AnalysisResult {
  priority: TicketPriority;
  urgencyScore: number;
  reasoning: string;
  category: string;
  impactScope: string;
  tackleGuide: string[];
}

interface Ticket {
  id: string;
  title: string;
  customerName: string;
  customerTier: "Free" | "Pro" | "Enterprise";
  description: string;
  createdAt: string;
  status: TicketStatus;
  analysis?: AnalysisResult;
}

// In-memory global state
let tickets: Ticket[] = [
  {
    id: "TCK-101",
    title: "Billing portal returns 500 when purchasing licenses",
    customerName: "Theresa Webb",
    customerTier: "Pro",
    description: "Our procurement team is attempting to checkout 45 seats for quarterly expansion. On clicking verify, a white screen of death is returned with correlation ID checkout_seat_prod_4413.",
    createdAt: new Date(Date.now() - 3600000 * 2).toISOString(), // 2 hours ago
    status: TicketStatus.ACKNOWLEDGED,
    analysis: {
      priority: TicketPriority.HIGH,
      urgencyScore: 82,
      category: "Billing System",
      impactScope: "Pro Accounts",
      reasoning: "The customer is a paying Pro tier customer attempting a high-value purchase. An unhandled server error in checkout blocks direct revenue flow, requiring high priority.",
      tackleGuide: [
        "Inspect the billing service logs for checkout_seat_prod_4413 correlation trace.",
        "Check Stripe/payment gateway logs for authorization delays or failed handshakes.",
        "Provide a manual override invoice for 45 seats to unblock customer procurement.",
        "Verify checkout API payload updates to prevent white-screen crashes."
      ]
    }
  },
  {
    id: "TCK-102",
    title: "Typo in user settings page placeholder",
    customerName: "Albert Flores",
    customerTier: "Free",
    description: "There is a typo under Settings > Security. The placeholder says 'Enter passowrd' instead of 'Enter password'. Fixing this would improve interface hygiene.",
    createdAt: new Date(Date.now() - 3600000 * 5).toISOString(), // 5 hours ago
    status: TicketStatus.RESOLVED,
    analysis: {
      priority: TicketPriority.LOW,
      urgencyScore: 15,
      category: "User Interface",
      impactScope: "Single User Feedback",
      reasoning: "A minor visual typo on a hidden settings page placeholder. There is absolutely zero operational or security impact.",
      tackleGuide: [
        "Locate the localization string map or settings file in codebase (/src/locales/en.json).",
        "Correct the typo spelling from 'passowrd' to 'password'.",
        "Add a visual hygiene check to our automated UI build unit tests."
      ]
    }
  },
  {
    id: "TCK-103",
    title: "Cannot connect custom SSL certificate with active DNS",
    customerName: "Acme Enterprises (Guy Hawkins)",
    customerTier: "Enterprise",
    description: "We recently uploaded an SSL SAN certificate for custom domain webhost.acme.org. Even though CNAME is fully resolved and points to ingress endpoints, custom cert verification fails repeatedly with SSL Handshake Timeouts.",
    createdAt: new Date(Date.now() - 60000 * 3).toISOString(), // 3 minutes ago
    status: TicketStatus.ACTIVE_ALERT,
    analysis: {
      priority: TicketPriority.CRITICAL,
      urgencyScore: 92,
      category: "Networking / SSL",
      impactScope: "Entire Organization",
      reasoning: "An active Enterprise client experiences blocked secure connection setups on a newly provisioned hostname. High urgency due to customer tier and operational disruption.",
      tackleGuide: [
        "Inspect our certificate manager ingress controller status for Acme's custom hostname.",
        "Run openssl s_client -connect webhost.acme.org:443 to observe TLS protocol handshake negotiations.",
        "Contact the customer's technical lead (Guy Hawkins) to confirm DNS propagation is complete.",
        "Check dynamic routing tables for custom domain routing configurations."
      ]
    }
  }
];

// Server-Sent Events clients list
let sseClients: any[] = [];

// Helper to broadcast ticket updates to all connected frontends
function broadcast(event: { type: string; data?: any; message?: string }) {
  console.log(`[SSE Broadcast] Event: ${event.type}`);
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  });
}

// Lazy-loaded Gemini SDK setup to adhere to security & crash constraints
let aiInstance: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not defined. Please add your key in the AI Studio Settings secrets panel.");
    }
    aiInstance = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiInstance;
}

// Core Gemma 4 31B analysis executor using gemini-3.5-flash as the engine proxy
async function runGemmaAnalysis(ticket: Ticket): Promise<AnalysisResult> {
  const ai = getAI();
  const systemInstruction = `
    You are Gemma 4 31B, a top-tier open-weights language model specializing in IT Operations, SRE support, and customer ticket analysis.
    Analyze the ticket metadata, category, and description, and respond with strict JSON evaluating the priority.
    
    You must classify the ticket into one of these priorities:
    - LOW: Cosmetic issues, typos, general questions without service impact.
    - MEDIUM: Individual non-blocking functionality bugs, isolated issues.
    - HIGH: Business-critical operations impacted for a customer segment, or high-tier accounts blocked in core workflows.
    - CRITICAL: Outages, production system crashes, security breaches, data corruption, or global disruption blocking operations (especially for Enterprise accounts).
    
    Assign an urgencyScore between 0 and 100.
    Detail your operational reasoning briefly and category, impactScope.
    Provide a specific step-by-step 'tackleGuide' of 3-5 concrete action items for a manager to immediately handle the ticket.
  `;

  const prompt = `
    Analyze the following customer ticket:
    
    TICKET ID: ${ticket.id}
    TITLE: "${ticket.title}"
    CUSTOMER: "${ticket.customerName}"
    TIER: "${ticket.customerTier}"
    DESCRIPTION: "${ticket.description}"
    
    Respond in JSON matching the exact schema definition.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          priority: {
            type: Type.STRING,
            description: "Must be exactly one of: LOW, MEDIUM, HIGH, CRITICAL."
          },
          urgencyScore: {
            type: Type.INTEGER,
            description: "An urgency rating from 0 (lowest alert severity) to 100 (complete critical emergency)."
          },
          reasoning: {
            type: Type.STRING,
            description: "Detailed system administrator analysis explaining this choice."
          },
          category: {
            type: Type.STRING,
            description: "Classification of what system failed, e.g., Cloud Server Outage, UI Bug, Auth Failure, Storage Leak."
          },
          impactScope: {
            type: Type.STRING,
            description: "Breadth of failure, e.g. Single Customer, Division, Global Region, All Live Environments."
          },
          tackleGuide: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "3 to 5 realistic operations instructions telling the manager how to tackle this specific issue first."
          }
        },
        required: ["priority", "urgencyScore", "reasoning", "category", "impactScope", "tackleGuide"]
      }
    }
  });

  const parsedText = response.text || "";
  try {
    const parsed = JSON.parse(parsedText);
    
    // Normalize priority to conform strictly to enum values
    let finalPriority = TicketPriority.MEDIUM;
    const prioUpper = String(parsed.priority).toUpperCase();
    if (Object.values(TicketPriority).includes(prioUpper as any)) {
      finalPriority = prioUpper as TicketPriority;
    }

    return {
      priority: finalPriority,
      urgencyScore: typeof parsed.urgencyScore === "number" ? parsed.urgencyScore : 50,
      reasoning: parsed.reasoning || "Analyzed by Gemma 4 31B.",
      category: parsed.category || "General Support",
      impactScope: parsed.impactScope || "Segment of Users",
      tackleGuide: Array.isArray(parsed.tackleGuide) ? parsed.tackleGuide : ["Triage description", "Verify host system status", "Engage correct technical channels"]
    };
  } catch (error) {
    console.error("JSON parsing error on Gemma response text:", parsedText, error);
    // Return a fallback evaluation if model returns corrupted JSON
    return {
      priority: ticket.customerTier === "Enterprise" ? TicketPriority.HIGH : TicketPriority.MEDIUM,
      urgencyScore: ticket.customerTier === "Enterprise" ? 80 : 40,
      reasoning: "Automatic fallback evaluation due to response metadata parsing anomalies.",
      category: "General Support",
      impactScope: ticket.customerTier === "Enterprise" ? "Enterprise Tenant" : "Single Account",
      tackleGuide: [
        "Conduct initial contact with sender.",
        "Perform basic manual triage.",
        "Confirm systems integration."
      ]
    };
  }
}

// ---------------------------------------------
// HTTP REST & SSE ROUTES
// ---------------------------------------------

// Server-Sent Events Endpoint
app.get("/api/tickets/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send an greeting/ping event to stabilize connection
  res.write(`data: ${JSON.stringify({ type: "init", message: "SSE Alert Stream Connected" })}\n\n`);

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter((client) => client !== res);
  });
});

// GET all tickets
app.get("/api/tickets", (req, res) => {
  res.json(tickets);
});

// POST to resolve a ticket
app.post("/api/tickets/resolve", (req, res) => {
  const { id } = req.body;
  const ticketIndex = tickets.findIndex((t) => t.id === id);
  if (ticketIndex === -1) {
    return res.status(404).json({ error: "Ticket not found" });
  }

  tickets[ticketIndex].status = TicketStatus.RESOLVED;
  broadcast({ type: "update", message: `Ticket ${id} resolved`, data: tickets[ticketIndex] });
  res.json(tickets[ticketIndex]);
});

// POST to acknowledge alert
app.post("/api/tickets/acknowledge", (req, res) => {
  const { id } = req.body;
  const ticketIndex = tickets.findIndex((t) => t.id === id);
  if (ticketIndex === -1) {
    return res.status(404).json({ error: "Ticket not found" });
  }

  tickets[ticketIndex].status = TicketStatus.ACKNOWLEDGED;
  broadcast({ type: "update", message: `Ticket alert ${id} acknowledged by manager`, data: tickets[ticketIndex] });
  res.json(tickets[ticketIndex]);
});

// POST a new customized ticket
app.post("/api/tickets", async (req, res) => {
  const { title, description, customerName, customerTier } = req.body;
  if (!title || !description || !customerName) {
    return res.status(400).json({ error: "Missing required fields (title, description, customerName)" });
  }

  const newTicket: Ticket = {
    id: `TCK-${Math.floor(100 + Math.random() * 900)}`,
    title,
    customerName,
    customerTier: customerTier || "Free",
    description,
    createdAt: new Date().toISOString(),
    status: TicketStatus.ANALYZING,
  };

  // Pre-add to global queue
  tickets.unshift(newTicket);
  
  // Broadcast analyzing stage immediately definitions
  broadcast({ type: "new", message: "Analyzing ticket via Gemma 4 31B", data: newTicket });
  res.json(newTicket);

  // Trigger analysis in the background
  try {
    const analysis = await runGemmaAnalysis(newTicket);
    const updatedTicketIndex = tickets.findIndex((t) => t.id === newTicket.id);
    if (updatedTicketIndex !== -1) {
      tickets[updatedTicketIndex].analysis = analysis;
      if (analysis.priority === TicketPriority.CRITICAL || analysis.priority === TicketPriority.HIGH) {
        tickets[updatedTicketIndex].status = TicketStatus.ACTIVE_ALERT;
      } else {
        tickets[updatedTicketIndex].status = TicketStatus.UNASSIGNED;
      }
      
      broadcast({
        type: "analyzed",
        message: `Analysis completed: Priority classified as ${analysis.priority}`,
        data: tickets[updatedTicketIndex],
      });
    }
  } catch (error: any) {
    console.error("Gemma analysis failed dynamically:", error);
    const updatedIndex = tickets.findIndex((t) => t.id === newTicket.id);
    if (updatedIndex !== -1) {
      tickets[updatedIndex].status = TicketStatus.UNASSIGNED;
      tickets[updatedIndex].analysis = {
        priority: TicketPriority.MEDIUM,
        urgencyScore: 50,
        category: "General Support",
        impactScope: "Single Account",
        reasoning: `Analysis failed due to API Key configuration state: ${error.message}`,
        tackleGuide: [
          "Connect external API keys in the AI Studio configuration menu.",
          "Check backend connection logs.",
          "Manually interview client regarding error reproduction steps."
        ],
      };
      broadcast({
        type: "analyzed",
        message: "Analysis failed (default values applied)",
        data: tickets[updatedIndex],
      });
    }
  }
});

// Demo injection helper to test live audible alerts instantly
app.post("/api/tickets/demo-inject", async (req, res) => {
  const { isCritical, forceEscalated } = req.body;

  const creationTime = forceEscalated 
    ? new Date(Date.now() - 11 * 60 * 1000).toISOString() 
    : new Date().toISOString();

  let demo: Ticket;
  if (isCritical) {
    demo = {
      id: `TCK-${Math.floor(100 + Math.random() * 900)}`,
      title: "DATABASE_CORRUPTION: PostgreSQL Primary node reporting corrupted heap blocks",
      customerName: "Acme National Bank",
      customerTier: "Enterprise",
      description: "Critical emergency alert triggered automatically by SRE health-checks. Sector B database block heap file 'pg_tbl_991.dat' contains invalid read headers. Financial audit table transaction data is unreachable. Immediate data restoration protocol required.",
      createdAt: creationTime,
      status: TicketStatus.ANALYZING,
    };
  } else {
    demo = {
      id: `TCK-${Math.floor(100 + Math.random() * 900)}`,
      title: "API Performance degradation in secondary staging environments",
      customerName: "Global Logistics Ltd",
      customerTier: "Pro",
      description: "Query execution latency for dev.getLogisticsMap API endpoints climbed to 2.4 seconds post patch update v4.2.1-b. Does not impact customer-facing production nodes yet, but hinders staging integrations.",
      createdAt: creationTime,
      status: TicketStatus.ANALYZING,
    };
  }

  tickets.unshift(demo);
  broadcast({ type: "new", message: "Demo incident generated", data: demo });
  res.json(demo);

  // Background analysis
  try {
    const analysis = await runGemmaAnalysis(demo);
    const index = tickets.findIndex((t) => t.id === demo.id);
    if (index !== -1) {
      tickets[index].analysis = analysis;
      if (analysis.priority === TicketPriority.CRITICAL || analysis.priority === TicketPriority.HIGH) {
        tickets[index].status = TicketStatus.ACTIVE_ALERT;
      } else {
        tickets[index].status = TicketStatus.UNASSIGNED;
      }
      broadcast({
        type: "analyzed",
        message: `Demo evaluated by Gemma 4 31B`,
        data: tickets[index],
      });
    }
  } catch (error: any) {
    console.error("Gemma demo run failed:", error);
    const index = tickets.findIndex((t) => t.id === demo.id);
    if (index !== -1) {
      tickets[index].status = TicketStatus.UNASSIGNED;
      tickets[index].analysis = {
        priority: isCritical ? TicketPriority.CRITICAL : TicketPriority.HIGH,
        urgencyScore: isCritical ? 98 : 75,
        category: isCritical ? "Database Corruption" : "Staging Degrade",
        impactScope: isCritical ? "Global Outage" : "Internal Dev Segment",
        reasoning: `Seeded with emergency values directly because API key was missing: ${error.message}`,
        tackleGuide: isCritical
          ? [
              "Halt all primary DB write commits immediately to prevent further block corruption cascade.",
              "Locate the latest incremental snapshot verified at 05:00 UTC and restore to staging VM.",
              "Notify high-priority management chain at Acme National Bank of recovery timelines.",
              "Promote the passive read-replica node to handle transactional flows in degraded read-only state."
            ]
          : [
              "Revert backend staging cluster commit v4.2.1-b.",
              "Run query execution plans on logistics map endpoints to trace table index scans.",
              "Benchmark API responses under synthetic traffic load tests."
            ],
      };
      
      if (tickets[index].analysis?.priority === TicketPriority.CRITICAL || tickets[index].analysis?.priority === TicketPriority.HIGH) {
        tickets[index].status = TicketStatus.ACTIVE_ALERT;
      }

      broadcast({
        type: "analyzed",
        message: "Applied emergency simulated analysis results",
        data: tickets[index],
      });
    }
  }
});

// Clear tickets endpoint
app.post("/api/tickets/clear", (req, res) => {
  tickets = [];
  broadcast({ type: "clear", message: "Ticket dashboard cleared" });
  res.json({ status: "cleared" });
});

// ---------------------------------------------
// SLA ESCALATION MONITORING BACKGROUND SERVICE
// ---------------------------------------------
setInterval(() => {
  tickets.forEach((t) => {
    if (
      t.status === TicketStatus.ACTIVE_ALERT &&
      t.analysis?.priority === TicketPriority.CRITICAL
    ) {
      const elapsedMs = Date.now() - new Date(t.createdAt).getTime();
      const limitMs = 10 * 60 * 1000;
      if (elapsedMs > limitMs) {
        const elapsedMin = Math.floor(elapsedMs / 1000 / 60);
        const elapsedSec = Math.floor((elapsedMs / 1000) % 60);
        console.error(
          `[SLA BREACH ERROR] Ticket ${t.id} ("${t.title}") has been in ACTIVE_ALERT unacknowledged for ${elapsedMin}m ${elapsedSec}s. Severe breach threshold of 10 minutes exceeded!`
        );
      }
    }
  });
}, 10000); // Check every 10 seconds

// ---------------------------------------------
// ENERGIZE VITE DEV SERVER OR PRODUCTIONS
// ---------------------------------------------
async function bootstrapServer() {
  // Bind standard port listener immediately so the container ingress is instantly active
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[INFRASTRUCTURE] Server successfully running at http://0.0.0.0:${PORT}`);
  });

  if (process.env.NODE_ENV !== "production") {
    // Development Mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
}

bootstrapServer();
