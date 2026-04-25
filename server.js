import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* -------------------------
   CLEAN
------------------------- */
const clean = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "");

/* -------------------------
   FETCH RSS
------------------------- */
async function fetchNews(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items.slice(0, 20).map(i => {
      const block = i[1];

      const title = (block.match(/<title>(.*?)<\/title>/)?.[1] || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "");

      const link = block.match(/<link>(.*?)<\/link>/)?.[1] || "";

      const source = title.split(" - ").pop();

      return { title, url: link, source };
    });

  } catch {
    return [];
  }
}

/* -------------------------
   SOURCE WEIGHT
------------------------- */
function sourceScore(source) {
  const s = source.toLowerCase();

  const high = ["reuters", "bbc", "associated press", "ap news", "al jazeera"];
  const medium = ["the hindu", "indian express", "times of india", "hindustan times"];

  if (high.some(x => s.includes(x))) return 3;
  if (medium.some(x => s.includes(x))) return 2;
  return 1;
}

/* -------------------------
   INTENT DETECTION
------------------------- */
function intentPenalty(title) {
  const t = title.toLowerCase();

  const entertainment = ["movie","film","netflix","review","ranking"];
  const opinion = ["opinion","editorial","analysis"];
  const speculative = ["could","might","may","rumor","speculation","possible"];

  let penalty = 0;

  if (entertainment.some(w => t.includes(w))) penalty += 4;
  if (opinion.some(w => t.includes(w))) penalty += 2;
  if (speculative.some(w => t.includes(w))) penalty += 1;

  return penalty;
}

/* -------------------------
   ENTITY MATCH SCORE
------------------------- */
function matchScore(query, title) {
  const words = clean(query).split(" ").filter(w => w.length > 2);
  const t = title.toLowerCase();

  let count = 0;

  words.forEach(w => {
    if (t.includes(w)) count++;
  });

  return count / words.length; // normalized
}

/* -------------------------
   FINAL SCORING ENGINE
------------------------- */
function rankArticles(query, articles) {
  return articles.map(a => {

    const match = matchScore(query, a.title);      // 0–1
    const credibility = sourceScore(a.source);     // 1–3
    const penalty = intentPenalty(a.title);        // 0–?

    // 🔥 final score formula
    const score = (match * 5) + credibility - penalty;

    return { ...a, score, match, credibility };

  })
  .filter(a => a.match > 0.3) // must be relevant
  .sort((a, b) => b.score - a.score);
}

/* -------------------------
   ANALYSIS
------------------------- */
function analyze(query, articles) {

  const ranked = rankArticles(query, articles);

  if (!ranked.length) {
    return {
      verdict: "Possibly Misleading",
      confidence: 20,
      reasoning: "No strong relevant news coverage",
      sources: articles.slice(0, 5)
    };
  }

  const top = ranked.slice(0, 8);

  const avgScore = top.reduce((s, a) => s + a.score, 0) / top.length;
  const avgCred = top.reduce((s, a) => s + a.credibility, 0) / top.length;

  // 🔥 DECISION LOGIC
  if (avgScore > 5 && avgCred > 2) {
    return {
      verdict: "Likely Real",
      confidence: Math.min(90, Math.round(avgScore * 15)),
      reasoning: "Strong multi-source confirmation",
      sources: top
    };
  }

  if (avgScore > 3) {
    return {
      verdict: "Unverified",
      confidence: 50,
      reasoning: "Partial or inconsistent coverage",
      sources: top
    };
  }

  return {
    verdict: "Possibly Misleading",
    confidence: 30,
    reasoning: "Weak relevance or low credibility signals",
    sources: top
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

/* ------------------------- */
app.listen(PORT, () => console.log("Server running"));