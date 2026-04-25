import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;

/* -------------------------
   CLEAN QUERY
------------------------- */
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

/* -------------------------
   FETCH NEWS
------------------------- */
async function fetchNews(text) {
  try {
    const query = cleanQuery(text);

    const res = await fetch(
      `https://gnews.io/api/v4/search?q=${query}&max=10&lang=en&apikey=${GNEWS_API_KEY}`
    );

    const data = await res.json();

    return (data.articles || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));

  } catch {
    return [];
  }
}

/* -------------------------
   SIMILARITY (JACCARD)
------------------------- */
function similarity(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();

  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));

  const intersection = [...wordsA].filter(x => wordsB.has(x)).length;
  const union = new Set([...wordsA, ...wordsB]).size;

  return union === 0 ? 0 : intersection / union;
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
    "the hindu",
    "indian express",
    "guardian",
    "al jazeera"
  ].some(x => s.includes(x));
}

/* -------------------------
   ANALYSIS ENGINE
------------------------- */
function analyzeTruth(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 20,
      reasoning: "No strong news coverage found"
    };
  }

  const top = articles.slice(0, 5);

  let similarityScore = 0;
  let trustedCount = 0;

  for (let a of top) {
    similarityScore += similarity(input, a.title);

    if (isTrusted(a.source)) trustedCount++;
  }

  similarityScore /= top.length;

  const trustRatio = trustedCount / top.length;

  const finalScore =
    similarityScore * 0.6 +
    trustRatio * 0.4;

  let verdict = "Unverified";

  if (finalScore > 0.7) verdict = "Likely Real";
  else if (finalScore < 0.3) verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.round(finalScore * 100),
    reasoning:
      `Similarity: ${(similarityScore * 100).toFixed(0)}%, ` +
      `Trusted sources: ${trustedCount}/${top.length}`
  };
}

/* -------------------------
   ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 Accuracy Improved Backend Running");
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

    const articles = await fetchNews(text);
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
      reasoning: "Server fallback triggered",
      sources: []
    });
  }
});

/* ------------------------- */
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on", PORT);
});