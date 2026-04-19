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
  console.error("❌ Missing API keys in .env file");
}

// Gemini setup - Temperature at 0 for absolute factual strictness
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json" // Natively forces bulletproof JSON
  }
});

// Clean input query
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5)
    .join(" ");
}

// Fetch news evidence
async function fetchNews(query) {
  if (!query) return [];
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=relevancy&language=en&pageSize=5&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "ok" && data.articles) {
      return data.articles.filter(a => a.title && !a.title.includes("[Removed]"));
    }
    return [];
  } catch (err) {
    console.error("News fetch error:", err.message);
    return [];
  }
}

// Verify news - The Ultimate AI-Driven Pipeline
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    // Prepare context for the AI
    const liveEvidence = articles.length > 0 
      ? JSON.stringify(articles.map(a => ({ title: a.title, description: a.description, url: a.url, source: a.source?.name })))
      : "[]";

    const prompt = `
    You are an elite fact-checking API. Verify the user's claim strictly and accurately.

    User Claim: "${text}"
    Live News Evidence: ${liveEvidence}

    Instructions:
    1. If the Live News Evidence proves the claim Real or Fake, use it.
    2. If the Live News Evidence is "[]" (empty) or irrelevant, YOU MUST use your internal historical knowledge to verify the claim. Do NOT default to "Uncertain" unless the claim is genuinely an unprovable opinion or prediction.
    3. You must provide a "label" (Real, Fake, or Uncertain).
    4. You must provide a "confidence" (High, Medium, or Low).
    5. You must provide a "reason" (A crisp, 1-2 sentence definitive explanation).
    6. You must provide a "sources" array:
       - If you used Live News Evidence, map those articles into the array.
       - If you used your internal knowledge, add the names of 2 reliable sources yourself (e.g., "Reuters", "BBC") and provide a relevant Google Search URL for the "url" field (e.g., "https://www.google.com/search?q=...").

    Respond EXACTLY with this JSON schema and nothing else:
    {
      "label": "Real" | "Fake" | "Uncertain",
      "confidence": "High" | "Medium" | "Low",
      "reason": "Explanation string",
      "sources": [
        {
          "title": "Headline or Topic string",
          "url": "Valid URL string",
          "source": "Publisher Name string"
        }
      ]
    }
    `;

    // AI generates the entire final JSON object perfectly mapped to your frontend
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());

    return parsed;

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    return {
      label: "Error",
      confidence: "None",
      reason: "Server failed to process the request.",
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

  if (!text || text.trim().length < 5) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Please enter a more detailed claim to verify.",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("🚀 Server running on port " + PORT));