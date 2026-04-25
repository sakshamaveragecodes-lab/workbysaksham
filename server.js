import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pipeline } from "@xenova/transformers";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

/* -------------------------
   LOAD MODEL ONCE (IMPORTANT)
------------------------- */
let embedder;

async function initModel() {
  embedder = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2"
  );
  console.log("✅ AI Model Ready");
}
await initModel();

/* -------------------------
   CLEAN QUERY
------------------------- */
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .slice(0, 12)
    .join(" ");
}

/* -------------------------
   FETCH NEWS (PARALLEL)
------------------------- */
async function fetchNews(query) {
  try {
    const gnewsURL = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=10&lang=en&apikey=${GNEWS_API_KEY}`;
    const mediaURL = `http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&languages=en&limit=10`;

    const [gRes, mRes] = await Promise.all([
      fetch(gnewsURL),
      fetch(mediaURL)
    ]);

    const gData = await gRes.json();
    const mData = await mRes.json();

    const gnews = (gData.articles || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));

    const mediastack = (mData.data || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source || "Unknown"
    }));

    // MERGE + REMOVE DUPLICATES
    const seen = new Set();
    const merged = [...gnews, ...mediastack].filter(a => {
      const key = a.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return merged.slice(0, 12);

  } catch (err) {
    console.error("Fetch error:", err);
    return [];
  }
}

/* -------------------------
   COSINE SIMILARITY
------------------------- */
function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* -------------------------
   SOURCE CREDIBILITY
------------------------- */
function sourceWeight(source = "") {
  const s = source.toLowerCase();

  if (s.includes("reuters")) return 1.0;
  if (s.includes("bbc")) return 0.95;
  if (s.includes("associated press") || s.includes("ap")) return 0.95;
  if (s.includes("the hindu")) return 0.9;
  if (s.includes("indian express")) return 0.9;
  if (s.includes("ndtv")) return 0.85;
  if (s.includes("al jazeera")) return 0.9;

  return 0.6;
}

/* -------------------------
   CORE ANALYSIS ENGINE
------------------------- */
async function analyze(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 10,
      reasoning: "No news coverage found"
    };
  }

  const inputVec = (await embedder(input))[0];

  let weightedScores = [];

  for (let a of articles) {
    const vec = (await embedder(a.title))[0];

    const similarity = cosine(inputVec, vec);
    const weight = sourceWeight(a.source);

    weightedScores.push(similarity * weight);
  }

  const avg =
    weightedScores.reduce((a, b) => a + b, 0) /
    weightedScores.length;

  const strongMatches =
    weightedScores.filter(s => s > 0.7).length;

  let verdict = "Unverified";

  if (avg > 0.75 && strongMatches >= 3)
    verdict = "Likely Real";
  else if (avg < 0.4)
    verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.round(avg * 100),
    reasoning: `Consensus: ${strongMatches} strong matches across sources`
  };
}

/* -------------------------
   ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 Best Version Backend Running");
});

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

    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    const result = await analyze(text, articles);

    res.json({
      ...result,
      sources: articles.slice(0, 5)
    });

  } catch (err) {
    console.error(err);

    res.json({
      verdict: "Error",
      confidence: 0,
      reasoning: "Server failure",
      sources: []
    });
  }
});

/* ------------------------- */
app.listen(PORT, () =>
  console.log(`🔥 Running on ${PORT}`)
);