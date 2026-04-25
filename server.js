import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* -------------------------
   FETCH NEWS (Google RSS)
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
   HUGGINGFACE EMBEDDING
------------------------- */
async function getEmbedding(text) {
  const res = await fetch(
    "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.HF_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: text })
    }
  );

  return await res.json();
}

/* -------------------------
   COSINE SIMILARITY
------------------------- */
function cosineSim(a, b) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (magA * magB);
}

/* -------------------------
   SOURCE CREDIBILITY
------------------------- */
function sourceScore(source) {
  const s = source.toLowerCase();

  const high = ["reuters", "bbc", "ap news", "associated press", "al jazeera"];
  const medium = ["the hindu", "indian express", "times of india", "hindustan times"];

  if (high.some(x => s.includes(x))) return 3;
  if (medium.some(x => s.includes(x))) return 2;
  return 1;
}

/* -------------------------
   INTENT FILTER
------------------------- */
function penalty(title) {
  const t = title.toLowerCase();

  const bad = ["movie","film","netflix","review","ranking","celebrity"];
  const opinion = ["opinion","editorial"];
  const rumor = ["rumor","might","could","speculation"];

  let p = 0;

  if (bad.some(w => t.includes(w))) p += 4;
  if (opinion.some(w => t.includes(w))) p += 2;
  if (rumor.some(w => t.includes(w))) p += 1;

  return p;
}

/* -------------------------
   SMART RANKING
------------------------- */
async function rank(query, articles) {

  const queryVec = await getEmbedding(query);

  const scored = [];

  for (let a of articles) {
    try {
      const vec = await getEmbedding(a.title);

      const sim = cosineSim(queryVec, vec);

      const cred = sourceScore(a.source);
      const pen = penalty(a.title);

      const score = (sim * 10) + cred - pen;

      if (sim > 0.45) {
        scored.push({ ...a, score, sim, cred });
      }

    } catch {}
  }

  return scored.sort((a, b) => b.score - a.score);
}

/* -------------------------
   FINAL ANALYSIS
------------------------- */
function analyze(scored) {

  if (!scored.length) {
    return {
      verdict: "Possibly Misleading",
      confidence: 20,
      reasoning: "No relevant or credible coverage found",
      sources: []
    };
  }

  const top = scored.slice(0, 8);

  const avgScore = top.reduce((s, a) => s + a.score, 0) / top.length;
  const avgCred = top.reduce((s, a) => s + a.cred, 0) / top.length;

  const consistency = top.length;

  if (avgScore > 6 && avgCred > 2 && consistency >= 5) {
    return {
      verdict: "Likely Real",
      confidence: Math.min(95, Math.round(avgScore * 12)),
      reasoning: "Strong agreement across multiple credible sources",
      sources: top
    };
  }

  if (avgScore > 4) {
    return {
      verdict: "Unverified",
      confidence: 50,
      reasoning: "Some relevant coverage but lacks strong confirmation",
      sources: top
    };
  }

  return {
    verdict: "Possibly Misleading",
    confidence: 30,
    reasoning: "Weak relevance or unreliable sources",
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

  const ranked = await rank(text, articles);

  const result = analyze(ranked);

  res.json(result);
});

/* ------------------------- */
app.listen(PORT, () => console.log("🚀 Smart backend running"));