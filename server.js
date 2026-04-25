import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* -------------------------
   CLEAN TEXT
------------------------- */
function clean(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

/* -------------------------
   FETCH FROM GNEWS
------------------------- */
async function fetchGNews(query) {
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=10&lang=en&apikey=${process.env.GNEWS_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.articles) return [];

    return data.articles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "GNews"
    }));

  } catch (err) {
    console.log("GNews error:", err.message);
    return [];
  }
}

/* -------------------------
   FETCH FROM MEDIASTACK
------------------------- */
async function fetchMediastack(query) {
  try {
    const url = `http://api.mediastack.com/v1/news?access_key=${process.env.MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&limit=10`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.data) return [];

    return data.data.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source || "Mediastack"
    }));

  } catch (err) {
    console.log("Mediastack error:", err.message);
    return [];
  }
}

/* -------------------------
   MERGE + REMOVE DUPLICATES
------------------------- */
function mergeArticles(a1, a2) {
  const seen = new Set();

  return [...a1, ...a2].filter(a => {
    const key = clean(a.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------
   FILTER RELEVANCE
------------------------- */
function filterArticles(query, articles) {
  const words = clean(query).split(" ");

  return articles
    .map(a => {
      let match = 0;
      words.forEach(w => {
        if (a.title.toLowerCase().includes(w)) match++;
      });

      return { ...a, score: match };
    })
    .filter(a => a.score >= Math.min(2, words.length))
    .sort((a, b) => b.score - a.score);
}

/* -------------------------
   ANALYSIS (UI SAFE)
------------------------- */
function analyze(query, articles) {

  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 10,
      reasoning: "APIs returned no data",
      sources: []
    };
  }

  const relevant = filterArticles(query, articles);

  // fallback if filtering removes everything
  const finalSources = relevant.length ? relevant : articles;

  let verdict = "Likely Real";
  let confidence = 70;

  if (!relevant.length) {
    verdict = "Unverified";
    confidence = 30;
  }

  return {
    verdict,
    confidence,
    reasoning: `${finalSources.length} sources analyzed`,
    sources: finalSources.slice(0, 8)
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

    // fetch both
    const [gnews, mediastack] = await Promise.all([
      fetchGNews(text),
      fetchMediastack(text)
    ]);

    const merged = mergeArticles(gnews, mediastack);

    const result = analyze(text, merged);

    res.json(result);

  } catch (err) {
    console.log(err);

    res.json({
      verdict: "Error",
      confidence: 0,
      reasoning: "Server error",
      sources: []
    });
  }
});

/* -------------------------
   ROOT
------------------------- */
app.get("/", (req, res) => {
  res.send("FINAL BACKEND WORKING 🚀");
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});