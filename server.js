import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

/* -------------------------
   CLEAN QUERY
------------------------- */
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .slice(0, 10)
    .join(" ");
}

/* -------------------------
   FETCH GNEWS
------------------------- */
async function fetchGNews(query) {
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(
      query
    )}&max=10&lang=en&apikey=${GNEWS_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    return (data.articles || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));
  } catch (err) {
    console.error("GNews Error:", err);
    return [];
  }
}

/* -------------------------
   FETCH MEDIASTACK
------------------------- */
async function fetchMediastack(query) {
  try {
    const url = `http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(
      query
    )}&languages=en&limit=10`;

    const res = await fetch(url);
    const data = await res.json();

    return (data.data || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source || "Unknown"
    }));
  } catch (err) {
    console.error("Mediastack Error:", err);
    return [];
  }
}

/* -------------------------
   COMBINED FETCH
------------------------- */
async function fetchAllNews(text) {
  const query = cleanQuery(text);

  const [gnews, mediastack] = await Promise.all([
    fetchGNews(query),
    fetchMediastack(query)
  ]);

  // merge + remove duplicates
  const combined = [...gnews, ...mediastack];

  const unique = [];
  const seen = new Set();

  for (let article of combined) {
    if (!seen.has(article.title)) {
      seen.add(article.title);
      unique.push(article);
    }
  }

  return unique.slice(0, 10);
}

/* -------------------------
   BETTER SIMILARITY
------------------------- */
function similarity(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();

  const wordsA = a.split(" ");
  const wordsB = b.split(" ");

  let match = 0;

  for (let word of wordsA) {
    if (wordsB.includes(word)) match++;
  }

  return match / Math.max(wordsA.length, 1);
}

/* -------------------------
   TRUSTED SOURCES
------------------------- */
function isTrusted(source = "") {
  const s = source.toLowerCase();

  return [
    "bbc",
    "reuters",
    "ap",
    "associated press",
    "the hindu",
    "indian express",
    "guardian",
    "al jazeera",
    "ndtv"
  ].some(x => s.includes(x));
}

/* -------------------------
   ANALYSIS ENGINE (IMPROVED)
------------------------- */
function analyzeTruth(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 20,
      reasoning: "No strong news coverage found"
    };
  }

  const top = articles.slice(0, 7);

  let similarityScore = 0;
  let trustedCount = 0;

  for (let a of top) {
    similarityScore += similarity(input, a.title);

    if (isTrusted(a.source)) trustedCount++;
  }

  similarityScore /= top.length;
  const trustRatio = trustedCount / top.length;

  const finalScore =
    similarityScore * 0.65 +
    trustRatio * 0.35;

  let verdict = "Unverified";

  if (finalScore > 0.75) verdict = "Likely Real";
  else if (finalScore < 0.35) verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.round(finalScore * 100),
    reasoning:
      `Match: ${(similarityScore * 100).toFixed(0)}%, ` +
      `Trusted: ${trustedCount}/${top.length}`
  };
}

/* -------------------------
   ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 FINAL FIXED BACKEND RUNNING");
});

app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.json({
        verdict: "Unverified",
        confidence: 20,
        reasoning: "No input provided",
        sources: []
      });
    }

    const articles = await fetchAllNews(text);
    const result = analyzeTruth(text, articles);

    res.json({
      ...result,
      sources: articles.slice(0, 5)
    });

  } catch (err) {
    console.error(err);

    res.json({
      verdict: "Unverified",
      confidence: 30,
      reasoning: "Server error fallback",
      sources: []
    });
  }
});

/* ------------------------- */
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on", PORT);
});