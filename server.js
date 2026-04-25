import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

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
   CLEAN QUERY
------------------------- */
function cleanQuery(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/* -------------------------
   FETCH NEWS (SAFE)
------------------------- */
async function fetchNews(query) {
  const cached = getCache(query);
  if (cached) {
    console.log("⚡ Cache hit:", query);
    return cached;
  }

  try {
    const gnewsURL = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=5&lang=en&apikey=${GNEWS_API_KEY}`;
    const mediaURL = `http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&limit=5`;

    const [gRes, mRes] = await Promise.allSettled([
      fetch(gnewsURL),
      fetch(mediaURL)
    ]);

    let articles = [];

    // GNews
    if (gRes.status === "fulfilled") {
      const gData = await gRes.value.json();
      console.log("GNews:", gData);
      articles.push(
        ...(gData.articles || []).map(a => ({
          title: a.title,
          url: a.url,
          source: a.source?.name || "Unknown"
        }))
      );
    }

    // Mediastack
    if (mRes.status === "fulfilled") {
      const mData = await mRes.value.json();
      console.log("Mediastack:", mData);
      articles.push(
        ...(mData.data || []).map(a => ({
          title: a.title,
          url: a.url,
          source: a.source || "Unknown"
        }))
      );
    }

    // REMOVE DUPLICATES
    const seen = new Set();
    const unique = articles.filter(a => {
      const key = a.title?.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const finalData = unique.slice(0, 8);

    setCache(query, finalData);

    return finalData;

  } catch (err) {
    console.error("Fetch error:", err);
    return [];
  }
}

/* -------------------------
   FALLBACK QUERY SYSTEM
------------------------- */
async function getArticlesSmart(input) {
  const base = cleanQuery(input);

  const queries = [
    base,
    base.split(" ").slice(0, 2).join(" "),
    base.split(" ")[0]
  ];

  for (let q of queries) {
    if (!q) continue;

    console.log("Trying query:", q);

    const result = await fetchNews(q);

    if (result.length > 0) {
      return result;
    }
  }

  return [];
}

/* -------------------------
   SIMPLE ANALYSIS
------------------------- */
function similarity(a, b) {
  const A = a.split(" ");
  const B = b.split(" ");

  let match = 0;
  for (let w of A) {
    if (B.includes(w)) match++;
  }

  return match / Math.max(A.length, 1);
}

function analyze(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 10,
      reasoning: "No news coverage found"
    };
  }

  const query = cleanQuery(input);

  const scores = articles.map(a =>
    similarity(query, cleanQuery(a.title))
  );

  const avg =
    scores.reduce((a, b) => a + b, 0) / scores.length;

  let verdict = "Unverified";

  if (avg > 0.6) verdict = "Likely Real";
  else if (avg < 0.3) verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.round(avg * 100),
    reasoning: `Matched ${articles.length} articles`
  };
}

/* -------------------------
   ROUTES
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
      sources: articles
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
  res.send("✅ FULLY FIXED BACKEND RUNNING");
});

app.listen(PORT, () => {
  console.log("🚀 Running on", PORT);
});