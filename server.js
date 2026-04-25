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
   CLEAN TEXT
------------------------- */
function clean(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

/* -------------------------
   IMPORTANT WORDS (REMOVE STOPWORDS)
------------------------- */
const STOPWORDS = new Set([
  "the","is","in","on","at","of","and","a","to","for","with","by","an"
]);

function extractKeywords(text) {
  return clean(text)
    .split(" ")
    .filter(w => w && !STOPWORDS.has(w));
}

/* -------------------------
   SMART MATCH SCORE
------------------------- */
function scoreMatch(queryWords, titleWords) {
  let match = 0;

  queryWords.forEach(q => {
    if (titleWords.includes(q)) match++;
  });

  return match / queryWords.length;
}

/* -------------------------
   FETCH NEWS
------------------------- */
async function fetchNews(query) {
  try {
    const gURL = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=10&lang=en&apikey=${GNEWS_API_KEY}`;
    const mURL = `http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&limit=10`;

    const [gRes, mRes] = await Promise.all([
      fetch(gURL),
      fetch(mURL)
    ]);

    const gData = await gRes.json();
    const mData = await mRes.json();

    let articles = [];

    if (gData.articles) {
      articles.push(...gData.articles.map(a => ({
        title: a.title,
        url: a.url,
        source: a.source?.name || "GNews"
      })));
    }

    if (mData.data) {
      articles.push(...mData.data.map(a => ({
        title: a.title,
        url: a.url,
        source: a.source || "Mediastack"
      })));
    }

    // Remove duplicates
    const seen = new Set();
    return articles.filter(a => {
      const key = clean(a.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  } catch (err) {
    console.error(err);
    return [];
  }
}

/* -------------------------
   FILTER + RANK
------------------------- */
function filterAndRank(query, articles) {
  const qWords = extractKeywords(query);

  return articles
    .map(a => {
      const tWords = extractKeywords(a.title);
      const score = scoreMatch(qWords, tWords);

      return { ...a, score };
    })
    .filter(a => a.score >= 0.5) // STRICT
    .sort((a, b) => b.score - a.score);
}

/* -------------------------
   ANALYSIS
------------------------- */
function analyze(query, articles) {
  if (!articles.length) {
    return {
      verdict: "Unverified",
      confidence: 5,
      reasoning: "No news found",
      sources: []
    };
  }

  const ranked = filterAndRank(query, articles);

  if (!ranked.length) {
    return {
      verdict: "Unverified",
      confidence: 10,
      reasoning: "No relevant articles",
      sources: []
    };
  }

  const avg =
    ranked.reduce((s, a) => s + a.score, 0) / ranked.length;

  let verdict = "Unverified";

  if (avg > 0.75) verdict = "Likely Real";
  else if (avg < 0.5) verdict = "Possibly Misleading";

  return {
    verdict,
    confidence: Math.round(avg * 100),
    reasoning: `${ranked.length} high-quality matches`,
    sources: ranked.slice(0, 8)
  };
}

/* -------------------------
   ROUTE
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

  const articles = await fetchNews(text);
  const result = analyze(text, articles);

  res.json(result);
});

/* -------------------------
   ROOT
------------------------- */
app.get("/", (req, res) => {
  res.send("FREE PRODUCTION BACKEND RUNNING ✅");
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});