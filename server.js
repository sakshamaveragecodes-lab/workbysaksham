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

  } catch (err) {
    console.error("❌ fetchNews error:", err);
    return [];
  }
}

/* -------------------------
   SAFE EMBEDDING
------------------------- */
async function getEmbedding(text) {
  try {
    if (!process.env.HF_API_KEY) throw new Error("No API key");

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

    const data = await res.json();

    if (!Array.isArray(data)) throw new Error("Invalid embedding");

    return data;

  } catch (err) {
    return null; // 🔥 fallback trigger
  }
}

/* -------------------------
   COSINE SIMILARITY
------------------------- */
function cosineSim(a, b) {
  try {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    return dot / (magA * magB);
  } catch {
    return 0;
  }
}

/* -------------------------
   SOURCE SCORE
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
   FILTER BAD CONTENT
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
   KEYWORD MATCH (FALLBACK)
------------------------- */
function keywordScore(query, title) {
  const q = query.toLowerCase().split(" ");
  const t = title.toLowerCase();

  let count = 0;
  q.forEach(w => {
    if (t.includes(w)) count++;
  });

  return count / q.length;
}

/* -------------------------
   SMART RANKING (AI + FALLBACK)
------------------------- */
async function rank(query, articles) {

  const queryVec = await getEmbedding(query);

  const scored = [];

  for (let a of articles) {

    let sim = 0;

    if (queryVec) {
      const vec = await getEmbedding(a.title);
      if (vec) sim = cosineSim(queryVec, vec);
    }

    // 🔥 fallback if AI fails
    if (!sim || sim === 0) {
      sim = keywordScore(query, a.title);
    }

    const cred = sourceScore(a.source);
    const pen = penalty(a.title);

    const score = (sim * 10) + cred - pen;

    if (sim > 0.2) {
      scored.push({ ...a, score, cred });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/* -------------------------
   FINAL DECISION
------------------------- */
function analyze(scored) {

  if (!scored.length) {
    return {
      verdict: "Possibly Misleading",
      confidence: 20,
      reasoning: "No strong relevant coverage",
      sources: []
    };
  }

  const top = scored.slice(0, 8);

  const avgScore = top.reduce((s, a) => s + a.score, 0) / top.length;
  const avgCred = top.reduce((s, a) => s + a.cred, 0) / top.length;

  if (avgScore > 6 && avgCred > 2) {
    return {
      verdict: "Likely Real",
      confidence: Math.min(95, Math.round(avgScore * 12)),
      reasoning: "Strong multi-source confirmation",
      sources: top
    };
  }

  if (avgScore > 4) {
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
    reasoning: "Weak or unreliable signals",
    sources: top
  };
}

/* -------------------------
   API ROUTE (NEVER FAILS)
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

    const articles = await fetchNews(text);

    const ranked = await rank(text, articles);

    const result = analyze(ranked);

    res.json(result);

  } catch (err) {
    console.error("🔥 SERVER ERROR:", err);

    res.json({
      verdict: "Unverified",
      confidence: 10,
      reasoning: "Server fallback response",
      sources: []
    });
  }
});

/* ------------------------- */
app.listen(PORT, () => console.log("🚀 Backend running"));