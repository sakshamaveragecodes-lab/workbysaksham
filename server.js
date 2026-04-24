import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/* -------------------------
   ✅ MIDDLEWARE
------------------------- */
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

const HF_API_KEY = process.env.HF_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

/* -------------------------
   🧠 SAFE HF EMBEDDING (ULTRA STABLE)
------------------------- */
async function getEmbedding(text, retries = 3) {
  try {
    const res = await fetch(
      "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(text)
      }
    );

    const data = await res.json();

    // Handle HF issues (model loading / errors)
    if (!Array.isArray(data)) {
      if (retries > 0) {
        console.log("🔁 HF retry...");
        await new Promise(r => setTimeout(r, 2000));
        return getEmbedding(text, retries - 1);
      }
      throw new Error(JSON.stringify(data));
    }

    const vectors = data[0];

    if (!vectors || !Array.isArray(vectors)) {
      throw new Error("Invalid embedding format");
    }

    // Mean pooling
    return vectors[0].map((_, i) =>
      vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length
    );

  } catch (err) {
    console.error("❌ Embedding error:", err.message);
    throw err;
  }
}

/* -------------------------
   📐 COSINE
------------------------- */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/* -------------------------
   🔑 KEYWORDS
------------------------- */
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(w => w.length > 3)
    .slice(0, 6);
}

/* -------------------------
   🌐 FETCH NEWS
------------------------- */
async function fetchNews(text) {
  const query = extractKeywords(text).join(" ");

  const [gnews, mediastack] = await Promise.all([
    fetch(`https://gnews.io/api/v4/search?q=${query}&max=4&lang=en&apikey=${GNEWS_API_KEY}`)
      .then(r => r.json())
      .then(d => d.articles || [])
      .catch(() => []),

    fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${query}&limit=4`)
      .then(r => r.json())
      .then(d => d.data || [])
      .catch(() => [])
  ]);

  const all = [
    ...gnews.map(a => ({
      title: a.title,
      desc: a.description,
      url: a.url,
      source: a.source?.name || "Unknown",
      date: new Date(a.publishedAt)
    })),
    ...mediastack.map(a => ({
      title: a.title,
      desc: a.description,
      url: a.url,
      source: a.source,
      date: new Date(a.published_at)
    }))
  ];

  // Deduplicate
  const seen = new Set();
  return all.filter(a => {
    const key = a.title?.toLowerCase().slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------
   🧭 BIAS DETECTION
------------------------- */
function detectBias(articles) {
  const sources = articles.map(a => (a.source || "").toLowerCase());

  let left = 0, right = 0;

  sources.forEach(s => {
    if (["cnn","bbc","guardian"].some(k => s.includes(k))) left++;
    if (["fox","nypost"].some(k => s.includes(k))) right++;
  });

  if (left > right + 1) return "Left-leaning";
  if (right > left + 1) return "Right-leaning";
  return "Balanced / Mixed";
}

/* -------------------------
   📊 ANALYSIS (STABLE)
------------------------- */
async function analyze(text) {

  if (!HF_API_KEY) {
    throw new Error("Missing HF_API_KEY");
  }

  const articles = await fetchNews(text);

  if (articles.length < 2) {
    return {
      verdict: "Suspicious",
      confidence: 30,
      bias: "Unknown",
      reason: "Not enough news coverage",
      sources: []
    };
  }

  const inputEmb = await getEmbedding(text);

  let scored = [];

  // LIMIT calls for HF free tier
  const limited = articles.slice(0, 2);

  for (let a of limited) {
    const combined = a.title + " " + (a.desc || "");

    const emb = await getEmbedding(combined);

    const sim = cosine(inputEmb, emb);

    const keywordScore = extractKeywords(text).filter(k =>
      combined.toLowerCase().includes(k)
    ).length * 0.05;

    const hours = (Date.now() - a.date) / (1000 * 60 * 60);
    const recency = hours < 24 ? 0.1 : hours < 72 ? 0.05 : 0;

    const score = sim * 0.75 + keywordScore + recency;

    scored.push({ ...a, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 2);

  const avg = top.reduce((s, a) => s + a.score, 0) / top.length;

  const confidence = Math.min(90, Math.round(avg * 100));

  let verdict = "Suspicious";
  if (confidence > 70) verdict = "Real";
  else if (confidence < 40) verdict = "Fake";

  return {
    verdict,
    confidence,
    bias: detectBias(top),
    reason: "Semantic + keyword + recency + multi-source",
    sources: top.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source
    }))
  };
}

/* -------------------------
   🚀 ROUTES
------------------------- */

// Root
app.get("/", (req, res) => {
  res.send("🚀 Veritas AI running");
});

// Prevent 404 confusion
app.get("/analyze", (req, res) => {
  res.send("Use POST request with JSON { text: 'your news' }");
});

// MAIN
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "No input provided" });
    }

    // Test HF first (prevents silent crash)
    await getEmbedding("test");

    const result = await analyze(text);

    res.json(result);

  } catch (err) {
    console.error("❌ SERVER ERROR:", err.message);

    res.status(500).json({
      error: "Analysis failed",
      details: err.message
    });
  }
});

/* -------------------------
   🚀 START
------------------------- */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🔥 Running on ${PORT}`);
});