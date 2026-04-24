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
   🧠 SAFE EMBEDDING (NO HANG GUARANTEE)
------------------------- */
async function getEmbedding(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(
      "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(text),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const data = await res.json();

    if (!Array.isArray(data)) {
      throw new Error("HF bad response");
    }

    const vectors = data[0];

    return vectors[0].map((_, i) =>
      vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length
    );

  } catch (err) {
    console.error("⚠️ HF failed → fallback used");

    // 🔥 fallback embedding (always works)
    return text
      .toLowerCase()
      .slice(0, 50)
      .split("")
      .map(c => c.charCodeAt(0) / 255);
  }
}

/* -------------------------
   📐 COSINE
------------------------- */
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
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
    .slice(0, 5);
}

/* -------------------------
   🌐 FETCH NEWS
------------------------- */
async function fetchNews(text) {
  const query = extractKeywords(text).join(" ");

  const [gnews, mediastack] = await Promise.all([
    fetch(`https://gnews.io/api/v4/search?q=${query}&max=3&lang=en&apikey=${GNEWS_API_KEY}`)
      .then(r => r.json())
      .then(d => d.articles || [])
      .catch(() => []),

    fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${query}&limit=3`)
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

  // remove duplicates
  const seen = new Set();
  return all.filter(a => {
    const key = a.title?.toLowerCase().slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------
   🧭 BIAS
------------------------- */
function detectBias(articles) {
  const sources = articles.map(a => (a.source || "").toLowerCase());

  let left = 0, right = 0;

  sources.forEach(s => {
    if (["cnn","bbc","guardian"].some(k => s.includes(k))) left++;
    if (["fox","nypost"].some(k => s.includes(k))) right++;
  });

  if (left > right) return "Left-leaning";
  if (right > left) return "Right-leaning";
  return "Balanced";
}

/* -------------------------
   📊 ANALYSIS
------------------------- */
async function analyze(text) {
  const articles = await fetchNews(text);

  if (articles.length === 0) {
    return {
      verdict: "Suspicious",
      confidence: 30,
      bias: "Unknown",
      reason: "No news coverage found",
      sources: []
    };
  }

  const inputEmb = await getEmbedding(text);

  let scored = [];

  // 🔥 ONLY 1 ARTICLE → avoids HF overload
  const limited = articles.slice(0, 1);

  for (let a of limited) {
    const combined = a.title + " " + (a.desc || "");

    const emb = await getEmbedding(combined);

    const sim = cosine(inputEmb, emb);

    const keywordScore = extractKeywords(text).filter(k =>
      combined.toLowerCase().includes(k)
    ).length * 0.05;

    const hours = (Date.now() - a.date) / (1000 * 60 * 60);
    const recency = hours < 24 ? 0.1 : 0;

    const score = sim * 0.8 + keywordScore + recency;

    scored.push({ ...a, score });
  }

  const top = scored;

  const avg = top.reduce((s, a) => s + a.score, 0) / top.length;

  const confidence = Math.min(85, Math.round(avg * 100));

  let verdict = "Suspicious";
  if (confidence > 70) verdict = "Real";
  else if (confidence < 40) verdict = "Fake";

  return {
    verdict,
    confidence,
    bias: detectBias(top),
    reason: "Hybrid analysis (semantic + keyword + recency)",
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
app.get("/", (req, res) => {
  res.send("🚀 Veritas AI running");
});

app.get("/analyze", (req, res) => {
  res.send("Use POST with JSON { text: 'your news' }");
});

app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "No input provided" });
    }

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