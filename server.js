import express from "express";
import cors from "cors";

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
   FETCH GOOGLE NEWS RSS
------------------------- */
async function fetchNews(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

    const res = await fetch(url);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items.slice(0, 12).map(item => {
      const block = item[1];

      const title = (block.match(/<title>(.*?)<\/title>/)?.[1] || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "");

      const link = (block.match(/<link>(.*?)<\/link>/)?.[1] || "");

      const source = title.split(" - ").pop();

      return { title, url: link, source };
    });

  } catch (err) {
    console.log("Fetch error:", err.message);
    return [];
  }
}

/* -------------------------
   SYNONYMS (SMART MATCHING)
------------------------- */
const synonyms = {
  usa: ["us", "usa", "america"],
  ceasefire: ["ceasefire", "truce", "deal", "agreement"],
  iran: ["iran"]
};

/* -------------------------
   FILTER + ENTITY MATCHING
------------------------- */
function filterArticles(query, articles) {
  const words = clean(query).split(" ").filter(w => w.length > 2);

  const blacklist = [
    "movie","movies","film","review","ranking",
    "netflix","trailer","series","celebrity"
  ];

  const weakWords = [
    "could","might","may","rumor","speculation",
    "believe","possible","unconfirmed"
  ];

  return articles
    .map(a => {
      const title = a.title.toLowerCase();

      let matchCount = 0;

      // ✅ smart keyword + synonym matching
      words.forEach(w => {
        const group = synonyms[w] || [w];

        if (group.some(g => title.includes(g))) {
          matchCount++;
        }
      });

      let score = matchCount;

      // ❌ remove junk
      if (blacklist.some(w => title.includes(w))) score -= 3;

      // ⚠️ penalize weak claims
      if (weakWords.some(w => title.includes(w))) score -= 1;

      return { ...a, score, matchCount };
    })
    // 🔥 require multiple keyword matches
    .filter(a => a.matchCount >= Math.ceil(words.length / 2))
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score);
}

/* -------------------------
   ANALYSIS ENGINE
------------------------- */
function analyze(query, articles) {

  const relevant = filterArticles(query, articles);

  const credible = [
    "reuters","bbc","associated press","ap news",
    "the hindu","indian express","al jazeera",
    "times of india","hindustan times"
  ];

  if (!relevant.length) {
    return {
      verdict: "Possibly Misleading",
      confidence: 20,
      reasoning: "No strong or relevant news coverage found",
      sources: articles.slice(0, 5)
    };
  }

  let credibilityScore = 0;

  relevant.forEach(a => {
    const src = a.source.toLowerCase();
    if (credible.some(c => src.includes(c))) {
      credibilityScore++;
    }
  });

  const ratio = credibilityScore / relevant.length;

  // ⚠️ speculative topics
  const speculativeWords = [
    "alien","ufo","ghost","time travel",
    "conspiracy","end of world"
  ];

  if (speculativeWords.some(w => query.toLowerCase().includes(w))) {
    return {
      verdict: "Unverified",
      confidence: 25,
      reasoning: "Speculative topic with no confirmed evidence",
      sources: relevant.slice(0, 5)
    };
  }

  if (ratio < 0.3) {
    return {
      verdict: "Possibly Misleading",
      confidence: 30,
      reasoning: "Low credibility or weak supporting evidence",
      sources: relevant.slice(0, 5)
    };
  }

  if (ratio < 0.6) {
    return {
      verdict: "Unverified",
      confidence: 50,
      reasoning: "Limited confirmation across reliable sources",
      sources: relevant.slice(0, 6)
    };
  }

  return {
    verdict: "Likely Real",
    confidence: 80,
    reasoning: "Multiple credible sources confirm the claim",
    sources: relevant.slice(0, 8)
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
        reasoning: "No input provided",
        sources: []
      });
    }

    const articles = await fetchNews(text);

    console.log("Fetched:", articles.length);

    const result = analyze(text, articles);

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
  res.send("VERITAS AI FINAL BACKEND 🚀");
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});