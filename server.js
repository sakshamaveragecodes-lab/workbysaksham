import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const HF_API_KEY = process.env.HF_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;

/* -------------------------
   🔑 KEYWORDS
------------------------- */
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(w => w.length > 3)
    .slice(0, 6);
}

/* -------------------------
   🌐 FETCH NEWS (BETTER COVERAGE)
------------------------- */
async function fetchNews(text) {
  const keywords = extractKeywords(text);

  const queries = [
    keywords.join(" "),
    keywords.slice(0, 3).join(" "),
    text.slice(0, 50)
  ];

  let results = [];

  for (let q of queries) {
    const [gnews, mediastack] = await Promise.all([
      fetch(`https://gnews.io/api/v4/search?q=${q}&max=5&lang=en&apikey=${GNEWS_API_KEY}`)
        .then(r => r.json())
        .then(d => d.articles || [])
        .catch(() => []),

      fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${q}&limit=5`)
        .then(r => r.json())
        .then(d => d.data || [])
        .catch(() => [])
    ]);

    results.push(
      ...gnews.map(a => ({
        title: a.title,
        desc: a.description,
        url: a.url,
        source: a.source?.name || "Unknown",
        date: new Date(a.publishedAt)
      })),
      ...mediastack.map(a => ({
        title: a.title,
        desc: a.description,
        url: a.url,
        source: a.source,
        date: new Date(a.published_at)
      }))
    );
  }

  // remove duplicates
  const seen = new Set();
  return results.filter(a => {
    const key = a.title?.toLowerCase().slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------
   🏢 SOURCE CREDIBILITY
------------------------- */
function sourceScore(source = "") {
  const s = source.toLowerCase();

  if (["bbc","reuters","ap","the hindu","indian express"].some(k => s.includes(k))) return 1;
  if (["times","ndtv","cnn"].some(k => s.includes(k))) return 0.7;

  return 0.4;
}

/* -------------------------
   📊 BASIC SCORING
------------------------- */
function scoreArticles(input, articles) {
  const keywords = extractKeywords(input);

  return articles.map(a => {
    const text = (a.title + " " + (a.desc || "")).toLowerCase();

    const keywordMatch = keywords.filter(k => text.includes(k)).length;

    const credibility = sourceScore(a.source);

    const hours = (Date.now() - a.date) / (1000 * 60 * 60);
    const recency = hours < 24 ? 1 : hours < 72 ? 0.7 : 0.4;

    const score = keywordMatch * 0.3 + credibility * 0.5 + recency * 0.2;

    return { ...a, score };
  }).sort((a, b) => b.score - a.score);
}

/* -------------------------
   🧠 AI REASONING (SAFE)
------------------------- */
async function aiCheck(text, articles) {

  if (!HF_API_KEY) return null;

  const context = articles
    .slice(0, 4)
    .map((a, i) => `${i + 1}. ${a.title}`)
    .join("\n");

  const prompt = `
Fact check:

"${text}"

Based on:
${context}

Return JSON:
{
 "verdict": "Real/Fake/Misleading/Unverified",
 "confidence": number,
 "reasoning": "short reason"
}
`;

  try {
    const res = await fetch(
      "https://api-inference.huggingface.co/models/google/flan-t5-large",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { max_new_tokens: 120 }
        })
      }
    );

    const data = await res.json();
    const output = data[0]?.generated_text;

    return JSON.parse(output);

  } catch {
    return null;
  }
}

/* -------------------------
   🔁 FALLBACK LOGIC
------------------------- */
function fallback(scored) {

  if (scored.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 20,
      reasoning: "No sources found"
    };
  }

  const avgScore = scored.slice(0, 3).reduce((s, a) => s + a.score, 0) / 3;

  let verdict = "Unverified";
  if (avgScore > 0.8) verdict = "Likely Real";
  else if (avgScore < 0.4) verdict = "Possibly Fake";

  return {
    verdict,
    confidence: Math.round(avgScore * 100),
    reasoning: "Based on source credibility and relevance"
  };
}

/* -------------------------
   📊 ANALYZE
------------------------- */
async function analyze(text) {

  const articles = await fetchNews(text);

  const scored = scoreArticles(text, articles);

  const aiResult = await aiCheck(text, scored);

  let finalResult;

  if (aiResult && aiResult.verdict) {
    finalResult = aiResult;
  } else {
    finalResult = fallback(scored);
  }

  return {
    ...finalResult,
    sources: scored.slice(0, 5)
  };
}

/* -------------------------
   🚀 ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 Hybrid V4 Running");
});

app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.json({
        verdict: "Unverified",
        confidence: 20,
        reasoning: "No input provided",
        sources: []
      });
    }

    const result = await analyze(text);

    res.json(result);

  } catch (err) {
    res.json({
      verdict: "Unverified",
      confidence: 30,
      reasoning: "Server fallback triggered",
      sources: []
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));