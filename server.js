import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* -------------------------
   CACHE
------------------------- */
const cache = new Map();

/* -------------------------
   FETCH NEWS
------------------------- */
async function fetchNews(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items.slice(0, 25).map(i => {
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
   CLEAN WORDS
------------------------- */
function words(text) {
  return text.toLowerCase().split(" ").filter(w => w.length > 2);
}

/* -------------------------
   SIMILARITY
------------------------- */
function similarity(a, b) {
  const w1 = words(a);
  const w2 = words(b);

  const common = w1.filter(w => w2.includes(w)).length;

  return common / Math.max(w1.length, 1);
}

/* -------------------------
   SOURCE SCORE
------------------------- */
function sourceScore(source) {
  const s = source.toLowerCase();

  if (["reuters","bbc","ap news","associated press"].some(x => s.includes(x))) return 3;
  if (["the hindu","indian express","times of india"].some(x => s.includes(x))) return 2;
  return 1;
}

/* -------------------------
   FILTER NOISE
------------------------- */
function penalty(title) {
  const t = title.toLowerCase();

  const junk = ["movie","film","review","ranking","celebrity"];
  const weak = ["rumor","might","could","speculation"];

  let p = 0;

  if (junk.some(w => t.includes(w))) p += 4;
  if (weak.some(w => t.includes(w))) p += 1;

  return p;
}

/* -------------------------
   PLAUSIBILITY
------------------------- */
function plausibilityPenalty(query) {
  const q = query.toLowerCase();

  const extreme = [
    "alien invasion",
    "moon made of diamond",
    "flat earth",
    "time travel",
    "teleportation"
  ];

  return extreme.some(x => q.includes(x)) ? 4 : 0;
}

/* -------------------------
   CLUSTERING (KEY FEATURE)
------------------------- */
function clusterArticles(articles) {
  const clusters = [];

  articles.forEach(article => {
    let placed = false;

    for (let cluster of clusters) {
      if (similarity(cluster[0].title, article.title) > 0.5) {
        cluster.push(article);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push([article]);
    }
  });

  return clusters;
}

/* -------------------------
   STANCE DETECTION
------------------------- */
function stanceScore(title) {
  const t = title.toLowerCase();

  const positive = ["confirmed","agrees","approved","signed"];
  const negative = ["denies","rejects","fake","false"];

  if (positive.some(w => t.includes(w))) return 1;
  if (negative.some(w => t.includes(w))) return -1;

  return 0;
}

/* -------------------------
   RANK
------------------------- */
function rank(query, articles) {
  return articles
    .map(a => {
      const sim = similarity(query, a.title);
      const cred = sourceScore(a.source);
      const pen = penalty(a.title);

      const score = (sim * 10) + cred - pen;

      return { ...a, score, cred, sim };
    })
    .filter(a => a.sim > 0.2)
    .sort((a, b) => b.score - a.score);
}

/* -------------------------
   ELITE ANALYSIS
------------------------- */
function analyze(query, ranked) {

  if (!ranked.length) {
    return {
      verdict: "Possibly Misleading",
      confidence: 20,
      reasoning: "No credible coverage",
      sources: []
    };
  }

  const clusters = clusterArticles(ranked);
  const topCluster = clusters.sort((a,b) => b.length - a.length)[0];

  const coverage = topCluster.length;

  const avgCred = topCluster.reduce((s, a) => s + a.cred, 0) / coverage;
  const avgScore = topCluster.reduce((s, a) => s + a.score, 0) / coverage;

  const stanceTotal = topCluster.reduce((s, a) => s + stanceScore(a.title), 0);

  const plausibility = plausibilityPenalty(query);

  // 🔥 contradiction detection
  const contradiction = Math.abs(stanceTotal) < coverage * 0.3;

  if (coverage < 3 || avgCred < 1.8) {
    return {
      verdict: "Possibly Misleading",
      confidence: 25,
      reasoning: "Weak or low-quality coverage",
      sources: topCluster.slice(0, 6)
    };
  }

  if (contradiction) {
    return {
      verdict: "Unverified",
      confidence: 45,
      reasoning: "Conflicting reports across sources",
      sources: topCluster.slice(0, 6)
    };
  }

  if ((avgScore - plausibility) > 6 && avgCred > 2) {
    return {
      verdict: "Likely Real",
      confidence: Math.min(92, Math.round((avgScore - plausibility) * 10)),
      reasoning: "Strong agreement across credible sources",
      sources: topCluster.slice(0, 8)
    };
  }

  return {
    verdict: "Possibly Misleading",
    confidence: 30,
    reasoning: "Low confidence or implausible claim",
    sources: topCluster.slice(0, 6)
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

    if (cache.has(text)) {
      return res.json(cache.get(text));
    }

    const articles = await fetchNews(text);
    const ranked = rank(text, articles);
    const result = analyze(text, ranked);

    cache.set(text, result);

    res.json(result);

  } catch (err) {
    console.error(err);

    res.json({
      verdict: "Unverified",
      confidence: 10,
      reasoning: "Fallback response",
      sources: []
    });
  }
});

/* ------------------------- */
app.listen(PORT, () => {
  console.log("🚀 Elite backend running");
});