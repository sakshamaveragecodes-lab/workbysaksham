import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const { GNEWS_API_KEY, MEDIASTACK_API_KEY } = process.env;

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------
// 🔥 SMART KEYWORD EXTRACTION
// -------------------------
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(w =>
      w.length > 3 &&
      !["this","that","with","have","from","they","were","been","about"].includes(w)
    )
    .slice(0, 6);
}

// -------------------------
// FETCH NEWS (with sorting)
// -------------------------
async function fetchNews(query) {
  const [gnews, mediastack] = await Promise.all([
    fetch(`https://gnews.io/api/v4/search?q=${query}&max=20&lang=en&sortby=relevance&apikey=${GNEWS_API_KEY}`)
      .then(r => r.json())
      .then(d => d.articles || [])
      .catch(() => []),

    fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${query}&languages=en&limit=20&sort=published_desc`)
      .then(r => r.json())
      .then(d => d.data || [])
      .catch(() => [])
  ]);

  return deduplicate([
    ...normalizeGNews(gnews),
    ...normalizeMediastack(mediastack)
  ]);
}

// -------------------------
function normalizeGNews(arr) {
  return arr.map(a => ({
    title: a.title || "",
    description: a.description || "",
    url: a.url,
    source: a.source?.name || "Unknown",
    publishedAt: new Date(a.publishedAt)
  }));
}

function normalizeMediastack(arr) {
  return arr.map(a => ({
    title: a.title || "",
    description: a.description || "",
    url: a.url,
    source: a.source || "Unknown",
    publishedAt: new Date(a.published_at)
  }));
}

// -------------------------
// REMOVE DUPLICATES BETTER
// -------------------------
function deduplicate(arr) {
  const seen = new Set();
  return arr.filter(a => {
    const key = a.title.toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -------------------------
// 🔥 ADVANCED SCORING
// -------------------------
function score(article, keywords, input) {
  const text = (article.title + " " + article.description).toLowerCase();

  let score = 0;

  // keyword match weight
  keywords.forEach(k => {
    if (text.includes(k)) score += 2;
  });

  // phrase similarity
  if (text.includes(input.toLowerCase().slice(0, 30))) {
    score += 5;
  }

  // recency boost (last 48h)
  const hoursOld = (Date.now() - article.publishedAt) / (1000 * 60 * 60);
  if (hoursOld < 48) score += 3;

  return { ...article, score };
}

// -------------------------
// AGREEMENT CALCULATION
// -------------------------
function calculateAgreement(articles) {
  const strong = articles.filter(a => a.score >= 6);
  return Math.round((strong.length / articles.length) * 100);
}

// -------------------------
function getVerdict(agreement) {
  if (agreement > 75) return "Real";
  if (agreement > 45) return "Suspicious";
  return "Fake";
}

// -------------------------
// ROUTE
// -------------------------
app.post("/analyze", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "No input" });
  }

  try {
    const keywords = extractKeywords(text);

    const queries = [
      keywords.join(" "),
      keywords.slice(0, 3).join(" "),
      text.slice(0, 80)
    ];

    const results = await Promise.all(queries.map(fetchNews));
    let articles = deduplicate(results.flat());

    // ❗ Filter weak articles early
    articles = articles.filter(a => a.title.length > 30);

    if (articles.length < 5) {
      return res.json({
        verdict: "Suspicious",
        confidence: 35,
        agreement: 25,
        reason: "Not enough reliable coverage",
        sources: []
      });
    }

    // 🔥 SCORE + SORT PROPERLY
    const scored = articles
      .map(a => score(a, keywords, text))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const agreement = calculateAgreement(scored);

    res.json({
      verdict: getVerdict(agreement),
      confidence: agreement,
      agreement,
      reason: "Cross-verified with multiple high-relevance sources",
      sources: scored.map(a => ({
        title: a.title,
        url: a.url
      }))
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------
app.get("/", (req, res) => {
  res.send("✅ Veritas AI running");
});

// -------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Running on ${PORT}`));