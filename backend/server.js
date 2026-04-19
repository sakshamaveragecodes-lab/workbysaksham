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

// Gemini (explanation only)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { temperature: 0.1 }
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
// 📰 FETCH DATA
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
// 🧹 FILTER LOW QUALITY
// ----------------------
function filterLowQuality(evidence) {
  return evidence.filter(e => {
    if (!e.title || e.title.length < 20) return false;
    if (!e.description || e.description.length < 40) return false;
    if (!e.url.startsWith("http")) return false;
    return true;
  });
}


// ----------------------
// 🧠 DOMAIN CREDIBILITY (NO HARDCODING)
// ----------------------
function domainScore(url) {
  try {
    const domain = new URL(url).hostname;

    let score = 0;

    if (domain.includes(".gov")) score += 3;
    if (domain.includes(".edu")) score += 3;

    if (domain.split(".").length <= 3) score += 1;

    if (!domain.includes("-")) score += 0.5;

    return score;
  } catch {
    return 0;
  }
}


// ----------------------
// 🧠 MATCH STRENGTH
// ----------------------
function matchScore(evidence, claim) {
  const words = claim.toLowerCase().split(" ");

  return evidence.map(e => {
    let match = 0;
    const text = (e.title + " " + e.description).toLowerCase();

    words.forEach(w => {
      if (w.length > 3 && text.includes(w)) match++;
    });

    return { ...e, match };
  });
}


// ----------------------
// ⚖️ STANCE
// ----------------------
function detectStance(evidence) {
  return evidence.map(e => {
    const text = (e.title + " " + e.description).toLowerCase();

    let stance = "neutral";

    if (
      text.includes("false") ||
      text.includes("fake") ||
      text.includes("hoax") ||
      text.includes("misleading") ||
      text.includes("debunk")
    ) {
      stance = "contradict";
    }

    else if (
      text.includes("official statement") ||
      text.includes("confirmed report")
    ) {
      stance = "support";
    }

    return { ...e, stance };
  });
}


// ----------------------
// 🏆 FINAL SCORING
// ----------------------
function scoreEvidence(evidence) {
  return evidence.map(e => {
    let score = 0;

    if (e.stance === "contradict") score -= 4;
    if (e.stance === "support") score += 3;

    score += e.match * 0.5;
    score += domainScore(e.url);

    if (e.description.length < 60) score -= 1;

    return { ...e, score };
  });
}


// ----------------------
// 🎯 VERDICT
// ----------------------
function finalVerdict(evidence) {
  let total = 0;
  evidence.forEach(e => total += e.score);

  const support = evidence.filter(e => e.stance === "support").length;
  const contradict = evidence.filter(e => e.stance === "contradict").length;

  if (contradict >= 2 || total <= -5) {
    return { label: "Fake", confidence: "High" };
  }

  if (support >= 3 && total >= 6) {
    return { label: "Real", confidence: "High" };
  }

  return { label: "Uncertain", confidence: "Low" };
}


// ----------------------
// 🧠 VERIFY
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

    if (evidence.length === 0) {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "No evidence found.",
        sources: []
      };
    }

    evidence = filterLowQuality(evidence);
    evidence = matchScore(evidence, text);
    evidence = detectStance(evidence);
    evidence = scoreEvidence(evidence);

    const { label, confidence } = finalVerdict(evidence);

    let reason = "No explanation available";

    try {
      const prompt = `
      Claim: "${text}"
      Verdict: ${label}

      Evidence:
      ${JSON.stringify(evidence)}

      Explain clearly.
      `;
      const ai = await model.generateContent(prompt);
      reason = ai.response.text();
    } catch {}

    const result = {
      label,
      confidence,
      reason,
      sources: evidence
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(e => ({
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

app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});


// ----------------------
// START
// ----------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log("🚀 Server running on " + PORT));