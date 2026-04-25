import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import natural from "natural";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

/* -------------------------
   NLP SETUP
------------------------- */
const TfIdf = natural.TfIdf;
const tokenizer = new natural.WordTokenizer();

/* -------------------------
   CACHE
------------------------- */
const cache = new Map();
const CACHE_TIME = 10 * 60 * 1000;

function getCache(key) {
  const data = cache.get(key);
  if (!data) return null;
  if (Date.now() - data.time > CACHE_TIME) {
    cache.delete(key);
    return null;
  }
  return data.value;
}

function setCache(key, value) {
  cache.set(key, { value, time: Date.now() });
}

/* -------------------------
   CLEAN TEXT
------------------------- */
function clean(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

/* -------------------------
   FETCH NEWS
------------------------- */
async function fetchNews(query) {
  const cached = getCache(query);
  if (cached) return cached;

  try {
    const gnewsURL = `https://gnews.io/api/v4/search?q=${query}&max=10&lang=en&apikey=${GNEWS_API_KEY}`;
    const mediaURL = `http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${query}&limit=10`;

    const [gRes, mRes] = await Promise.allSettled([
      fetch(gnewsURL),
      fetch(mediaURL)
    ]);

    let articles = [];

    if (gRes.status === "fulfilled") {
      const gData = await gRes.value.json();
      articles.push(
        ...(gData.articles || []).map(a => ({
          title: a.title,
          url: a.url,
          source: a.source?.name || "GNews",
          weight: 1.0
        }))
      );
    }

    if (mRes.status === "fulfilled") {
      const mData = await mRes.value.json();
      articles.push(
        ...(mData.data || []).map(a => ({
          title: a.title,
          url: a.url,
          source: a.source || "Mediastack",
          weight: 0.9
        }))
      );
    }

    // REMOVE DUPLICATES
    const seen = new Set();
    const unique = articles.filter(a => {
      const key = clean(a.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    setCache(query, unique);
    return unique;

  } catch (err) {
    console.error(err);
    return [];
  }
}

/* -------------------------
   SMART QUERY FALLBACK
------------------------- */
async function getArticlesSmart(input) {
  const base = clean(input);

  const queries = [
    base,
    base.split(" ").slice(0, 3).join(" "),
    base.split(" ")[0]
  ];

  for (let q of queries) {
    if (!q) continue;
    const res = await fetchNews(q);
    if (res.length > 3) return res;
  }

  return [];
}

/* -------------------------
   SEMANTIC SCORING
------------------------- */
function computeSimilarity(query, articles) {
  const tfidf = new TfIdf();

  tfidf.addDocument(query);

  articles.forEach(a => {
    tfidf.addDocument(clean(a.title));
  });

  let scores = [];

  articles.forEach((a, i) => {
    let score = 0;

    tokenizer.tokenize(query).forEach(word => {
      score += tfidf.tfidf(word, i + 1);
    });

    scores.push(score * a.weight);
  });

  return scores;
}

/* -------------------------
   SOURCE CREDIBILITY
------------------------- */
function credibilityScore(source) {
  const trusted = [
    "reuters", "bbc", "ap", "associated press",
    "the hindu", "indian express", "nyt", "guardian"
  ];

  source = source.toLowerCase();

  return trusted.some(s => source.includes(s)) ? 1.2 : 1.0;
}

/* -------------------------
   FINAL ANALYSIS
------------------------- */
function analyze(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 5,
      reasoning: "No credible coverage found",
      bias: "Unknown"
    };
  }

  const scores = computeSimilarity(input, articles);

  let weighted = scores.map((s, i) => {
    return s * credibilityScore(articles[i].source);
  });

  const avg =
    weighted.reduce((a, b) => a + b, 0) / weighted.length;

  let verdict = "Unverified";

  if (avg > 2.5) verdict = "Likely Real";
  else if (avg < 1.2) verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.min(95, Math.round(avg * 25)),
    reasoning: `${articles.length} sources analyzed with semantic matching`,
    bias: "Low"
  };
}

/* -------------------------
   ROUTE
------------------------- */
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.json({
        verdict: "Unverified",
        confidence: 0,
        reasoning: "No input",
        sources: []
      });
    }

    const articles = await getArticlesSmart(text);
    const result = analyze(text, articles);

    res.json({
      ...result,
      sources: articles.slice(0, 8)
    });

  } catch (err) {
    console.error(err);
    res.json({
      verdict: "Error",
      confidence: 0,
      reasoning: "Server error",
      sources: []
    });
  }
});

app.get("/", (req, res) => {
  res.send("🚀 PRODUCTION BACKEND RUNNING");
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});