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
   CACHE SYSTEM
------------------------- */
const cache = new Map();
const CACHE_TIME = 10 * 60 * 1000; // 10 minutes

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
  cache.set(key, {
    value,
    time: Date.now()
  });
}

/* -------------------------
   CLEAN QUERY
------------------------- */
function cleanQuery(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .slice(0, 10)
    .join(" ");
}

/* -------------------------
   FETCH NEWS (LIMIT SAFE)
------------------------- */
async function fetchNews(query) {
  const cached = getCache(query);
  if (cached) {
    console.log("⚡ Using cache");
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

    if (gRes.status === "fulfilled") {
      const gData = await gRes.value.json();
      articles.push(...(gData.articles || []));
    }

    if (mRes.status === "fulfilled") {
      const mData = await mRes.value.json();
      articles.push(...(mData.data || []));
    }

    const formatted = articles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || a.source || "Unknown"
    }));

    // REMOVE DUPLICATES
    const seen = new Set();
    const unique = formatted.filter(a => {
      const key = a.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const finalData = unique.slice(0, 8);

    setCache(query, finalData); // SAVE CACHE

    return finalData;

  } catch (err) {
    console.error(err);
    return [];
  }
}

/* -------------------------
   SIMPLE ANALYSIS
------------------------- */
function similarity(a, b) {
  const wordsA = a.split(" ");
  const wordsB = b.split(" ");

  let match = 0;

  for (let w of wordsA) {
    if (wordsB.includes(w)) match++;
  }

  return match / Math.max(wordsA.length, 1);
}

function analyze(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 10,
      reasoning: "No coverage"
    };
  }

  const query = cleanQuery(input);

  let scores = articles.map(a =>
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
    reasoning: "Cached + optimized scoring"
  };
}

/* -------------------------
   ROUTES
------------------------- */
app.post("/analyze", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.json({
      verdict: "Unverified",
      confidence: 0,
      reasoning: "No input",
      sources: []
    });
  }

  const query = cleanQuery(text);

  const articles = await fetchNews(query);
  const result = analyze(text, articles);

  res.json({
    ...result,
    sources: articles
  });
});

app.get("/", (req, res) => {
  res.send("✅ API LIMIT SAFE BACKEND RUNNING");
});

app.listen(PORT, () => {
  console.log("🚀 Running on", PORT);
});