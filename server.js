import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const { HF_API_KEY, GNEWS_API_KEY, MEDIASTACK_API_KEY } = process.env;

/* -------------------------
   🧠 EMBEDDING (HF)
------------------------- */
async function getEmbedding(text) {
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

  // mean pooling
  const vectors = data[0];
  return vectors[0].map((_, i) =>
    vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length
  );
}

/* -------------------------
   📐 SIMILARITY
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
   🌐 FETCH NEWS (multi-query)
------------------------- */
async function fetchNews(text) {
  const keywords = extractKeywords(text);

  const queries = [
    keywords.join(" "),
    keywords.slice(0, 3).join(" "),
    text.slice(0, 80)
  ];

  let results = [];

  for (let q of queries) {
    const [gnews, mediastack] = await Promise.all([
      fetch(`https://gnews.io/api/v4/search?q=${q}&max=5&lang=en&apikey=${GNEWS_API_KEY}`)
        .then(r => r.json())
        .then(d => d.articles || [])
        .catch(() => []),

      fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${q}&limit=5`)
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

  // deduplicate
  const seen = new Set();
  return results.filter(a => {
    const key = a.title.toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------
   🧭 BIAS DETECTION
------------------------- */
function detectBias(articles) {
  const sources = articles.map(a => a.source.toLowerCase());

  const left = sources.filter(s =>
    ["cnn","nytimes","guardian"].some(k => s.includes(k))
  ).length;

  const right = sources.filter(s =>
    ["fox","dailywire","nypost"].some(k => s.includes(k))
  ).length;

  if (left > right + 2) return "Left-leaning";
  if (right > left + 2) return "Right-leaning";
  return "Balanced / Mixed";
}

/* -------------------------
   📊 HYBRID SCORING
------------------------- */
async function analyze(text) {
  const articles = await fetchNews(text);

  if (articles.length < 5) {
    return {
      verdict: "Suspicious",
      confidence: 35,
      bias: "Unknown",
      reason: "Not enough coverage",
      sources: []
    };
  }

  const inputEmb = await getEmbedding(text);

  let scored = [];

  for (let a of articles) {
    const combined = a.title + " " + (a.desc || "");
    const emb = await getEmbedding(combined);

    const sim = cosine(inputEmb, emb);

    // keyword overlap
    const overlap = extractKeywords(text).filter(k =>
      combined.toLowerCase().includes(k)
    ).length;

    // recency boost
    const hours = (Date.now() - a.date) / (1000 * 60 * 60);
    const recency = hours < 24 ? 0.1 : hours < 72 ? 0.05 : 0;

    const score = sim * 0.7 + overlap * 0.05 + recency;

    scored.push({ ...a, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 6);

  const avg = top.reduce((s, a) => s + a.score, 0) / top.length;
  const confidence = Math.min(95, Math.round(avg * 100));

  let verdict = "Suspicious";
  if (confidence > 70) verdict = "Real";
  else if (confidence < 40) verdict = "Fake";

  return {
    verdict,
    confidence,
    bias: detectBias(top),
    reason: "Analyzed using semantic similarity, recency, and multi-source agreement",
    sources: top.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source
    }))
  };
}

/* -------------------------
   🚀 ROUTE
------------------------- */
app.post("/analyze", async (req, res) => {
  try {
    const result = await analyze(req.body.text);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/", (req, res) => {
  res.send("🚀 Veritas AI (Hybrid HF) Running");
});

app.listen(10000, () => console.log("Running on 10000"));