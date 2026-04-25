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
   🔑 UTIL
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
   🌐 FETCH NEWS
------------------------- */
async function fetchNews(text) {
  try {
    const keywords = extractKeywords(text);
    const query = keywords.join(" ");

    const [gnews, mediastack] = await Promise.all([
      fetch(`https://gnews.io/api/v4/search?q=${query}&max=5&lang=en&apikey=${GNEWS_API_KEY}`)
        .then(r => r.json())
        .then(d => d.articles || [])
        .catch(() => []),

      fetch(`http://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${query}&limit=5`)
        .then(r => r.json())
        .then(d => d.data || [])
        .catch(() => [])
    ]);

    const combined = [
      ...gnews.map(a => ({
        title: a.title,
        desc: a.description,
        url: a.url,
        source: a.source?.name || "Unknown"
      })),
      ...mediastack.map(a => ({
        title: a.title,
        desc: a.description,
        url: a.url,
        source: a.source
      }))
    ];

    // dedupe
    const seen = new Set();
    return combined.filter(a => {
      const key = a.title?.toLowerCase().slice(0, 80);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  } catch {
    return [];
  }
}

/* -------------------------
   🧠 AI FACT CHECK
------------------------- */
async function aiCheck(text, articles) {

  const context = articles
    .slice(0, 5)
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

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
          parameters: { max_new_tokens: 150 }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const data = await res.json();
    const output = data[0]?.generated_text || "";

    return JSON.parse(output);

  } catch {
    return null;
  }
}

/* -------------------------
   🔁 FALLBACK LOGIC
------------------------- */
function fallbackCheck(articles) {

  if (articles.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 20,
      reasoning: "No sources found"
    };
  }

  const trustedList = ["bbc","reuters","ap","the hindu","indian express"];

  const trusted = articles.some(a =>
    trustedList.some(s => a.source?.toLowerCase().includes(s))
  );

  return {
    verdict: trusted ? "Likely Real" : "Unverified",
    confidence: trusted ? 65 : 40,
    reasoning: trusted
      ? "Covered by trusted sources"
      : "Limited coverage"
  };
}

/* -------------------------
   📊 ANALYZE
------------------------- */
async function analyze(text) {

  const articles = await fetchNews(text);

  // Try AI first
  const aiResult = await aiCheck(text, articles);

  let finalResult;

  if (aiResult && aiResult.verdict) {
    finalResult = aiResult;
  } else {
    finalResult = fallbackCheck(articles);
  }

  return {
    ...finalResult,
    sources: articles.slice(0, 5)
  };
}

/* -------------------------
   🚀 ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 Fact Checker Running");
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
    console.error(err);

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