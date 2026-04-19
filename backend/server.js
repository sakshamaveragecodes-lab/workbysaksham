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
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY;

// Gemini (explanation only)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { temperature: 0.1 }
});


// ----------------------
// ⚡ CACHE (5 min TTL)
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
  cache.set(key, {
    value,
    time: Date.now()
  });
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
// 📰 NEWS API
// ----------------------
async function fetchNews(query) {
  const cached = getCache("news_" + query);
  if (cached) return cached;

  try {
    const url = `https://newsapi.org/v2/everything?q=${query}&pageSize=5&sortBy=relevancy&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const results = data.articles?.map(a => ({
      title: a.title,
      description: a.description || "",
      url: a.url,
      source: a.source?.name || ""
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
      source: i.displayLink
    })) || [];

    setCache("google_" + query, results);
    return results;

  } catch {
    return [];
  }
}


// ----------------------
// 🧠 EMBEDDINGS
// ----------------------
async function getEmbedding(text) {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${EMBEDDING_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text
      })
    });

    const data = await res.json();
    return data.data?.[0]?.embedding || null;

  } catch {
    return null;
  }
}


// ----------------------
// 🔢 COSINE SIM
// ----------------------
function cosineSim(a, b) {
  if (!a || !b) return 0;

  let dot = 0, magA = 0, magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}


// ----------------------
// 🎯 SEMANTIC FILTER (LIMITED)
// ----------------------
async function semanticFilter(evidence, claim) {
  const limited = evidence.slice(0, 5);

  const claimVec = await getEmbedding(claim);
  if (!claimVec) return limited;

  const results = [];

  for (const e of limited) {
    const vec = await getEmbedding(e.title + " " + e.description);
    const sim = cosineSim(claimVec, vec);

    if (sim > 0.7) {
      results.push({ ...e, sim });
    }
  }

  return results.length ? results : limited;
}


// ----------------------
// ⚖️ STANCE
// ----------------------
function detectStance(evidence) {
  return evidence.map(e => {
    const text = (e.title + " " + e.description).toLowerCase();

    let stance = "neutral";

    if (text.includes("false") || text.includes("fake") || text.includes("debunk")) {
      stance = "contradict";
    }

    if (text.includes("confirmed") || text.includes("official") || text.includes("announced")) {
      stance = "support";
    }

    return { ...e, stance };
  });
}


// ----------------------
// 🏆 SCORING
// ----------------------
function scoreEvidence(evidence) {
  return evidence.map(e => {
    let score = 0;

    if (e.stance === "support") score += 2;
    if (e.stance === "contradict") score -= 2;

    if (e.description.length > 80) score += 1;
    if (e.source) score += 1;

    return { ...e, score };
  });
}


// ----------------------
// 🎯 VERDICT
// ----------------------
function finalVerdict(evidence) {
  let total = 0;
  evidence.forEach(e => total += e.score);

  if (total >= 5) return { label: "Real", confidence: "High" };
  if (total <= -5) return { label: "Fake", confidence: "High" };
  if (total > 1) return { label: "Real", confidence: "Medium" };
  if (total < -1) return { label: "Fake", confidence: "Medium" };

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

    if (evidence.length === 0) {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "No evidence found.",
        sources: []
      };
    }

    evidence = await semanticFilter(evidence, text);
    evidence = detectStance(evidence);
    evidence = scoreEvidence(evidence);

    // ⚡ EARLY EXIT
    const supportCount = evidence.filter(e => e.stance === "support").length;
    const rejectCount = evidence.filter(e => e.stance === "contradict").length;

    if (supportCount >= 3) {
      const result = {
        label: "Real",
        confidence: "High",
        reason: "Multiple sources support this claim.",
        sources: evidence
      };
      setCache("final_" + text, result);
      return result;
    }

    if (rejectCount >= 3) {
      const result = {
        label: "Fake",
        confidence: "High",
        reason: "Multiple sources contradict this claim.",
        sources: evidence
      };
      setCache("final_" + text, result);
      return result;
    }

    const { label, confidence } = finalVerdict(evidence);

    // AI explanation (only if needed)
    let reason = "No explanation available";

    try {
      const prompt = `
      Claim: "${text}"
      Verdict: ${label}

      Evidence:
      ${JSON.stringify(evidence)}

      Explain briefly.
      `;

      const ai = await model.generateContent(prompt);
      reason = ai.response.text();
    } catch {}

    const result = {
      label,
      confidence,
      reason,
      sources: evidence.map(e => ({
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