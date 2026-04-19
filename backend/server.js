import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ENV
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Gemini setup (Configured strictly for JSON output to ensure reliable parsing)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { 
    temperature: 0.1,
    responseMimeType: "application/json" 
  }
});

// ----------------------
// ⚡ CACHE
// ----------------------
const cache = new Map();

function getCache(key) {
  const data = cache.get(key);
  if (!data) return null;
  if (Date.now() - data.time > 5 * 60 * 1000) {
    cache.delete(key);
    return null;
  }
  return data.value;
}

function setCache(key, value) {
  cache.set(key, { value, time: Date.now() });
}

// ----------------------
// 🔍 SMART QUERY GENERATOR
// ----------------------
function generateSearchQuery(text) {
  // Removes special characters, grabs the first 8-10 words to prevent API errors, 
  // and explicitly appends 'fact check' to force search engines to find debunks.
  const baseQuery = text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .slice(0, 8)
    .join(" ");
  return `${baseQuery} fact check`;
}

// ----------------------
// 📰 FETCH NEWS (RESTRICTED TO TOP-TIER SOURCES)
// ----------------------
async function fetchNews(query) {
  const cached = getCache("news_" + query);
  if (cached) return cached;

  try {
    // Only fetch from highly credible, fact-based organizations
    const trustedDomains = "apnews.com,reuters.com,bbc.co.uk,bbc.com,snopes.com,politifact.com,npr.org,nytimes.com,washingtonpost.com";
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&domains=${trustedDomains}&pageSize=5&sortBy=relevancy&apiKey=${NEWS_API_KEY}`;
    
    const res = await fetch(url);
    const data = await res.json();

    const results = data.articles?.map(a => ({
      title: a.title,
      description: a.description || a.content || "",
      url: a.url,
      source: a.source?.name || "News Provider"
    })) || [];

    setCache("news_" + query, results);
    return results;
  } catch (err) {
    console.error("NewsAPI Error:", err.message);
    return [];
  }
}

// ----------------------
// 🌐 GOOGLE SEARCH
// ----------------------
async function fetchGoogle(query) {
  const cached = getCache("google_" + query);
  if (cached) return cached;

  try {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];

    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&num=5`;
    const res = await fetch(url);
    const data = await res.json();

    const results = data.items?.map(i => ({
      title: i.title,
      description: i.snippet || "",
      url: i.link,
      source: i.displayLink
    })) || [];

    setCache("google_" + query, results);
    return results;
  } catch (err) {
    console.error("Google Search Error:", err.message);
    return [];
  }
}

// ----------------------
// 🧠 LLM-POWERED VERDICT
// ----------------------
async function verifyNews(claim) {
  const cached = getCache("final_" + claim);
  if (cached) return cached;

  try {
    const query = generateSearchQuery(claim);

    // Fetch evidence in parallel
    const [news, google] = await Promise.all([
      fetchNews(query),
      fetchGoogle(query)
    ]);

    // Combine and deduplicate URLs
    let rawEvidence = [...news, ...google];
    const uniqueUrls = new Set();
    const evidence = [];
    
    for (const item of rawEvidence) {
      if (item.url && !uniqueUrls.has(item.url) && item.description.length > 30) {
        uniqueUrls.add(item.url);
        evidence.push(item);
      }
    }

    if (evidence.length === 0) {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "No credible evidence or fact-checks could be found for this claim.",
        sources: []
      };
    }

    // 🔥 Let Gemini do the heavy lifting for Context, Stance, and Verdict
    const prompt = `
      You are an elite, objective fact-checker. Analyze the following claim using ONLY the provided real-time search evidence.
      
      Claim: "${claim}"
      
      Evidence Data:
      ${JSON.stringify(evidence.slice(0, 8))}

      Determine if the claim is "Real", "Fake", or "Uncertain" based purely on the evidence. 
      Identify the stance of each source (support, contradict, or neutral).
      
      Respond strictly with a JSON object in this format:
      {
        "label": "Real" | "Fake" | "Uncertain",
        "confidence": "High" | "Medium" | "Low",
        "reason": "A 2-3 sentence objective explanation of why this verdict was reached based on the evidence.",
        "sources": [
          {
            "title": "Source title",
            "url": "Source URL",
            "source": "Domain/Source Name",
            "stance": "support" | "contradict" | "neutral"
          }
        ]
      }
    `;

    const aiResponse = await model.generateContent(prompt);
    const jsonText = aiResponse.response.text();
    
    // Parse the strict JSON returned by Gemini
    const result = JSON.parse(jsonText);

    setCache("final_" + claim, result);
    return result;

  } catch (error) {
    console.error("Verification Error:", error);
    return {
      label: "Error",
      confidence: "None",
      reason: "An error occurred during verification. Please try again.",
      sources: []
    };
  }
}

// ----------------------
// ROUTES
// ----------------------
app.get("/", (req, res) => {
  res.send("Fact Check Backend Running ✅");
});

app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text || text.trim().length < 10) {
    return res.status(400).json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Please enter a valid, complete claim to verify.",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

// ----------------------
// START
// ----------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Fact-Check Server running on port ${PORT}`));