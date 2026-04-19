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

// Gemini (only explanation)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { temperature: 0.2 }
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
// 🔍 KEYWORDS
// ----------------------
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(w => w.length > 2)
    .slice(0, 10)
    .join(" ");
}


// ----------------------
// 📰 FETCH NEWS
// ----------------------
async function fetchNews(query) {
  const cached = getCache("news_" + query);
  if (cached) return cached;

  try {
    const url = `https://newsapi.org/v2/everything?q=${query}&pageSize=6&sortBy=relevancy&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const results = data.articles?.map(a => ({
      title: a.title,
      description: a.description || "",
      url: a.url,
      source: a.source?.name || "",
      publishedAt: a.publishedAt || ""
    })) || [];

    setCache("news_" + query, results);
    return results;

  } catch {
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

    const url = `https://www.googleapis.com/customsearch/v1?q=${query}&key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}`;
    const res = await fetch(url);
    const data = await res.json();

    const results = data.items?.map(i => ({
      title: i.title,
      description: i.snippet || "",
      url: i.link,
      source: i.displayLink,
      publishedAt: ""
    })) || [];

    setCache("google_" + query, results);
    return results;

  } catch {
    return [];
  }
}


// ----------------------
// 🧹 CLEAN BAD SOURCES
// ----------------------
function cleanEvidence(evidence) {
  return evidence.filter(e => {
    if (!e.url) return false;

    // ❌ remove junk
    if (e.url.includes("youtube")) return false;
    if (e.url.includes("shorts")) return false;

    if (!e.description || e.description.length < 50) return false;

    return true;
  });
}


// ----------------------
// 🎯 RELEVANCE FILTER
// ----------------------
function isRelevant(evidence, claim) {
  const claimWords = claim.toLowerCase().split(" ");
  const text = (evidence.title + " " + evidence.description).toLowerCase();

  let matches = 0;

  claimWords.forEach(w => {
    if (w.length > 4 && text.includes(w)) matches++;
  });

  return matches >= 2;
}


// ----------------------
// ⚖️ STANCE DETECTION
// ----------------------
function detectStance(evidence) {
  return evidence.map(e => {
    const text = (e.title + " " + e.description).toLowerCase();

    let stance = "neutral";

    if (
      text.includes("false") ||
      text.includes("fake") ||
      text.includes("debunk") ||
      text.includes("misleading")
    ) {
      stance = "contradict";
    }

    else if (
      text.includes("confirmed") ||
      text.includes("announced") ||
      text.includes("reported") ||
      text.includes("according to")
    ) {
      stance = "support";
    }

    return { ...e, stance };
  });
}


// ----------------------
// 🎯 FINAL VERDICT (BALANCED)
// ----------------------
function finalVerdict(evidence) {
  const support = evidence.filter(e => e.stance === "support").length;
  const contradict = evidence.filter(e => e.stance === "contradict").length;

  if (contradict >= 2) {
    return { label: "Fake", confidence: "High" };
  }

  if (support >= 1 && contradict === 0) {
    return { label: "Real", confidence: "Medium" };
  }

  return { label: "Uncertain", confidence: "Low" };
}


// ----------------------
// 🧠 MAIN VERIFY
// ----------------------
async function verifyNews(text) {
  const cached = getCache("final_" + text);
  if (cached) return cached;

  try {
    const query = extractKeywords(text);

    const [news, google] = await Promise.all([
      fetchNews(query),
      fetchGoogle(query)
    ]);

    let evidence = [...news, ...google];

    // 🔥 CLEAN + FILTER
    evidence = cleanEvidence(evidence);
    evidence = evidence.filter(e => isRelevant(e, text));

    if (evidence.length === 0) {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "No relevant evidence found.",
        sources: []
      };
    }

    evidence = detectStance(evidence);

    const { label, confidence } = finalVerdict(evidence);

    // 🧠 Explanation
    let reason = "Based on available sources.";

    try {
      const prompt = `
      Claim: "${text}"
      Verdict: ${label}
      Evidence: ${JSON.stringify(evidence)}

      Explain simply.
      `;
      const ai = await model.generateContent(prompt);
      reason = ai.response.text();
    } catch {}

    const result = {
      label,
      confidence,
      reason,
      sources: evidence.slice(0, 5).map(e => ({
        title: e.title,
        url: e.url,
        source: e.source,
        stance: e.stance
      }))
    };

    setCache("final_" + text, result);
    return result;

  } catch {
    return {
      label: "Error",
      confidence: "None",
      reason: "Verification failed.",
      sources: []
    };
  }
}


// ----------------------
// ROUTES
// ----------------------
app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});

app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text || text.length < 5) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Enter a valid claim.",
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
app.listen(PORT, () => console.log("🚀 Server running on " + PORT));