import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

const HF_API_KEY = process.env.HF_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

/* -------------------------
   🧠 STABLE EMBEDDING (WITH TIMEOUT + FALLBACK)
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

    if (!Array.isArray(data)) throw new Error("HF failed");

    const vectors = data[0];

    return vectors[0].map((_, i) =>
      vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length
    );

  } catch {
    // fallback (never fail)
    return text
      .toLowerCase()
      .slice(0, 60)
      .split("")
      .map(c => c.charCodeAt(0) / 255);
  }
}

/* ------------------------- */
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/* ------------------------- */
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(w => w.length > 3)
    .slice(0, 6);
}

/* -------------------------
   🌐 FETCH MORE NEWS (MULTI QUERY)
------------------------- */
async function fetchNews(text) {
  const keywords = extractKeywords(text);

  const queries = [
    keywords.join(" "),
    keywords.slice(0, 3).join(" "),
    text.slice(0, 60)
  ];

  let results = [];

  for (let q of queries) {
    const [gnews, mediastack] = await Promise.all([
      fetch(`https://gnews.io/api/v4/search?q=${q}&max=5&lang=en&sortby=relevance&apikey=${GNEWS_API_KEY}`)
        .then(r => r.json())
        .then(d => d.articles || [])
        .catch(() => []),

      fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${q}&limit=5&sort=published_desc`)
        .then(r => r.json())
        .then(d => d.data || [])
        .catch(() => [])
    ]);

    results.push(
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
    );
  }

  // remove duplicates
  const seen = new Set();
  return results.filter(a => {
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
   📊 ANALYSIS (HYBRID)
------------------------- */
async function analyze(text) {
  const articles = await fetchNews(text);

  if (articles.length < 3) {
    return {
      verdict: "Suspicious",
      confidence: 30,
      bias: "Unknown",
      reason: "Low news coverage",
      sources: []
    };
  }

  const inputEmb = await getEmbedding(text);

  let scored = [];

  // Only top 4 for AI (stability)
  const limited = articles.slice(0, 4);

  for (let a of limited) {
    const combined = a.title + " " + (a.desc || "");

    const emb = await getEmbedding(combined);

    const sim = cosine(inputEmb, emb);

    const keywordScore = extractKeywords(text).filter(k =>
      combined.toLowerCase().includes(k)
    ).length * 0.05;

    const hours = (Date.now() - a.date) / (1000 * 60 * 60);
    const recency =
      hours < 12 ? 0.15 :
      hours < 48 ? 0.08 :
      hours < 120 ? 0.03 : 0;

    const trusted =
      ["bbc","reuters","ap","the hindu","indian express"]
        .some(s => a.source?.toLowerCase().includes(s));

    const sourceScore = trusted ? 0.1 : 0;

    const score = sim * 0.7 + keywordScore + recency + sourceScore;

    scored.push({ ...a, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 5);

  const avg = top.reduce((s, a) => s + a.score, 0) / top.length;

  const confidence = Math.min(92, Math.round(avg * 100));

  let verdict = "Suspicious";
  if (confidence > 70) verdict = "Real";
  else if (confidence < 40) verdict = "Fake";

  return {
    verdict,
    confidence,
    bias: detectBias(top),
    reason: "Hybrid scoring: semantic + keyword + recency + trusted sources",
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
    console.error("SERVER ERROR:", err.message);

    res.status(500).json({
      error: "Analysis failed",
      details: err.message
    });
  }
});

/* ------------------------- */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🔥 Running on ${PORT}`);
});