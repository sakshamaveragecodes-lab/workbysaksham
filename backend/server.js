import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!NEWS_API_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing API keys");
}

// Gemini setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.2
  }
});

// Clean input
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .filter(w => w.length > 2)
    .slice(0, 6)
    .join(" ");
}

// Fetch news (improved)
async function fetchNews(query) {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "ok") {
      return data.articles;
    }
    return [];
  } catch (err) {
    console.log("News error:", err.message);
    return [];
  }
}

// Verify news (AI upgraded)
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    // Remove duplicates + weak titles
    const unique = [];
    const seen = new Set();

    for (let a of articles) {
      const key = a.title?.toLowerCase();
      if (key && !seen.has(key) && a.title.length > 20) {
        seen.add(key);
        unique.push(a);
      }
    }

    const finalArticles = unique.slice(0, 5);

    const context = finalArticles.length
      ? finalArticles.map(a => `- ${a.title}`).join("\n")
      : "No reliable news found";

    const sources = finalArticles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));

    const prompt = `
You are a strict fact-checking AI.

Claim:
"${text}"

News Evidence:
${context}

Rules:
- If multiple sources support → Real
- If sources contradict → Fake
- If no strong evidence → Uncertain
- Do NOT guess

Return JSON ONLY:
{
  "label": "Real" | "Fake" | "Uncertain",
  "reason": "Short explanation"
}
`;

    let parsed;

    try {
      const result = await model.generateContent(prompt);
      const raw = result.response.text();
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        label: "Uncertain",
        reason: "AI could not confidently verify this claim"
      };
    }

    return {
      label: parsed.label || "Uncertain",
      confidence: finalArticles.length >= 3 ? "High" : "Medium",
      reason: parsed.reason || "Analysis completed",
      sources
    };

  } catch (err) {
    console.log("VERIFY ERROR:", err);
    return {
      label: "Error",
      confidence: "None",
      reason: "Server failed",
      sources: []
    };
  }
}

// Routes
app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});

app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text || text.length < 5) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Enter a valid claim",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("🚀 Server running"));