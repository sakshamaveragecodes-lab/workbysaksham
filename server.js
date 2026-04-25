import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const cache = new Map();

/* ---------------- QUERY NORMALIZATION ---------------- */
function normalizeQuery(q) {
  return q
    .toLowerCase()
    .replace(/\busa\b/g, "us")
    .replace(/\buk\b/g, "united kingdom")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------- FETCH: GNEWS ---------------- */
async function fetchGNews(query) {
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&country=in&max=10&apikey=${process.env.GNEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    return data.articles?.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source.name
    })) || [];
  } catch {
    return [];
  }
}

/* ---------------- FETCH: MEDIASTACK ---------------- */
async function fetchMediastack(query) {
  try {
    const url = `http://api.mediastack.com/v1/news?access_key=${process.env.MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&languages=en&limit=10`;
    const res = await fetch(url);
    const data = await res.json();

    return data.data?.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source
    })) || [];
  } catch {
    return [];
  }
}

/* ---------------- FETCH: GOOGLE RSS ---------------- */
async function fetchGoogle(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items.map(i => {
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

/* ---------------- NLP ---------------- */
function words(text) {
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
}

function relevanceScore(query, title) {
  const q = words(query);
  const t = words(title);

  let score = 0;
  q.forEach(w => {
    if (t.includes(w)) score += 2;
  });

  return score / (t.length || 1);
}

/* ---------------- SOURCE SCORING ---------------- */
function sourceScore(source) {
  const s = source.toLowerCase();

  if (["reuters","bbc","associated press"].some(x => s.includes(x)))
    return 4;

  if (["the hindu","indian express"].some(x => s.includes(x)))
    return 3;

  if (["ndtv","times of india"].some(x => s.includes(x)))
    return 2;

  return 1;
}

/* ---------------- PENALTY ---------------- */
function penalty(title) {
  const t = title.toLowerCase();
  let p = 0;

  if (["celebrity","movie","review"].some(w => t.includes(w))) p += 3;
  if (["rumor","might","unverified"].some(w => t.includes(w))) p += 2;

  return p;
}

/* ---------------- SIMILARITY ---------------- */
function similarity(a, b) {
  const w1 = words(a);
  const w2 = words(b);
  const common = w1.filter(w => w2.includes(w)).length;
  return common / Math.max(w1.length, 1);
}

/* ---------------- CLUSTER ---------------- */
function cluster(articles) {
  const clusters = [];

  for (let art of articles) {
    let found = false;

    for (let c of clusters) {
      if (similarity(c[0].title, art.title) > 0.5) {
        c.push(art);
        found = true;
        break;
      }
    }

    if (!found) clusters.push([art]);
  }

  return clusters.sort((a, b) => b.length - a.length);
}

/* ---------------- AGREEMENT (FIXED) ---------------- */
function computeAgreement(cluster) {
  if (cluster.length < 2) return 0;

  let total = 0;
  let count = 0;

  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      total += similarity(cluster[i].title, cluster[j].title);
      count++;
    }
  }

  return total / count;
}

/* ---------------- ANALYSIS ---------------- */
function analyze(query, articles) {

  if (!articles.length) {
    return {
      verdict: "Unverified ❓",
      confidence: 20,
      reasoning: "No coverage found",
      sources: []
    };
  }

  const ranked = articles.map(a => {
    const relevance = relevanceScore(query, a.title);
    const cred = sourceScore(a.source);
    const pen = penalty(a.title);

    const score = (relevance * 10) + cred - pen;

    return { ...a, score, relevance, cred };
  })
  .filter(a => a.relevance > 0.08)
  .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      verdict: "Unverified ❓",
      confidence: 25,
      reasoning: "Weak relevance",
      sources: []
    };
  }

  const clusters = cluster(ranked);
  const main = clusters[0];

  const coverage = main.length;
  const avgCred = main.reduce((s, a) => s + a.cred, 0) / coverage;
  const agreement = computeAgreement(main);

  /* -------- FINAL DECISION -------- */

  if (coverage >= 5 && avgCred >= 2.5 && agreement > 0.5) {
    return {
      verdict: "Verified ✅",
      confidence: Math.min(95, Math.round((coverage * 10) + (agreement * 50))),
      reasoning: "Multiple trusted sources report the same story",
      sources: main.slice(0, 8)
    };
  }

  if (agreement < 0.25) {
    return {
      verdict: "Conflicting ⚠️",
      confidence: 45,
      reasoning: "Different narratives across sources",
      sources: main.slice(0, 6)
    };
  }

  if (coverage < 3) {
    return {
      verdict: "Unverified ❓",
      confidence: 30,
      reasoning: "Not enough coverage",
      sources: main.slice(0, 5)
    };
  }

  return {
    verdict: "Likely Real 👍",
    confidence: Math.min(90, Math.round((coverage * 8) + (avgCred * 10))),
    reasoning: "Consistent reporting across sources",
    sources: main.slice(0, 6)
  };
}

/* ---------------- ROUTE ---------------- */
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.json({
        verdict: "Unverified ❓",
        confidence: 0,
        reasoning: "Empty input",
        sources: []
      });
    }

    if (cache.has(text)) {
      return res.json(cache.get(text));
    }

    const query = normalizeQuery(text);

    const [gnews, mediastack, google] = await Promise.all([
      fetchGNews(query),
      fetchMediastack(query),
      fetchGoogle(query)
    ]);

    const allArticles = [...gnews, ...mediastack, ...google];

    const result = analyze(query, allArticles);

    cache.set(text, result);
    res.json(result);

  } catch (err) {
    res.json({
      verdict: "Unverified ❓",
      confidence: 10,
      reasoning: "Server error",
      sources: []
    });
  }
});

app.listen(PORT, () => {
  console.log("🚀 Veritas AI ELITE (Fully Fixed) running");
});