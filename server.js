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
   FETCH NEWS (SAFE)
------------------------- */
async function fetchNews(query) {
  try {
    const gnewsURL = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=10&lang=en&apikey=${GNEWS_API_KEY}`;
    const mediaURL = `http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&languages=en&limit=10`;

    const [gRes, mRes] = await Promise.allSettled([
      fetch(gnewsURL),
      fetch(mediaURL)
    ]);

    let articles = [];

    // GNews
    if (gRes.status === "fulfilled") {
      const gData = await gRes.value.json();
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
      const key = a.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return unique.slice(0, 10);

  } catch (err) {
    console.error("Fetch error:", err);
    return [];
  }
}

/* -------------------------
   SIMPLE BUT EFFECTIVE SCORING
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

/* -------------------------
   SOURCE TRUST
------------------------- */
function sourceScore(source = "") {
  const s = source.toLowerCase();

  if (s.includes("reuters")) return 1;
  if (s.includes("bbc")) return 0.95;
  if (s.includes("ap")) return 0.95;
  if (s.includes("the hindu")) return 0.9;
  if (s.includes("indian express")) return 0.9;
  if (s.includes("ndtv")) return 0.85;

  return 0.6;
}

/* -------------------------
   ANALYSIS (FAST + STABLE)
------------------------- */
function analyze(input, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 10,
      reasoning: "No coverage found"
    };
  }

  const query = cleanQuery(input);

  let scores = [];

  for (let a of articles) {
    const sim = similarity(query, cleanQuery(a.title));
    const trust = sourceScore(a.source);

    scores.push(sim * trust);
  }

  const avg =
    scores.reduce((a, b) => a + b, 0) / scores.length;

  const strong =
    scores.filter(s => s > 0.5).length;

  let verdict = "Unverified";

  if (avg > 0.6 && strong >= 3)
    verdict = "Likely Real";
  else if (avg < 0.3)
    verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.round(avg * 100),
    reasoning: `Matched ${strong} sources with decent similarity`
  };
}

/* -------------------------
   ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("✅ Backend Working Perfectly");
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
    const result = analyze(text, articles);

    res.json({
      ...result,
      sources: articles.slice(0, 5)
    });

  } catch (err) {
    console.error(err);

    res.json({
      verdict: "Error",
      confidence: 0,
      reasoning: "Server crashed",
      sources: []
    });
  }
});

/* ------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Running on port ${PORT}`);
});