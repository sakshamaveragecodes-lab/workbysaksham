import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const MEDIASTACK_API_KEY = process.env.MEDIASTACK_API_KEY;
const HF_API_KEY = process.env.HF_API_KEY;

/* -------------------------
   GLOBAL SAFETY (NO CRASH)
------------------------- */
process.on("uncaughtException", err => {
  console.error("UNCAUGHT:", err);
});

process.on("unhandledRejection", err => {
  console.error("UNHANDLED:", err);
});

/* -------------------------
   FETCH NEWS (SAFE)
------------------------- */
async function fetchNews(text) {
  try {
    const query = text.split(" ").slice(0, 5).join(" ");

    const [gnews, mediastack] = await Promise.all([
      fetch(`https://gnews.io/api/v4/search?q=${query}&max=5&lang=en&apikey=${GNEWS_API_KEY}`)
        .then(r => r.json())
        .then(d => d.articles || [])
        .catch(() => []),

      fetch(`https://api.mediastack.com/v1/news?access_key=${MEDIASTACK_API_KEY}&keywords=${query}&limit=5`)
        .then(r => r.json())
        .then(d => d.data || [])
        .catch(() => [])
    ]);

    return [
      ...gnews.map(a => ({
        title: a.title,
        url: a.url,
        source: a.source?.name || "Unknown"
      })),
      ...mediastack.map(a => ({
        title: a.title,
        url: a.url,
        source: a.source
      }))
    ];
  } catch {
    return [];
  }
}

/* -------------------------
   AI CHECK (SAFE)
------------------------- */
async function aiCheck(text, articles) {
  if (!HF_API_KEY) return null;

  const context = articles
    .slice(0, 4)
    .map(a => a.title)
    .join("\n");

  const prompt = `
Fact check:
"${text}"

Based on:
${context}

Return JSON:
{
 "verdict": "",
 "confidence": number,
 "reasoning": ""
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
        body: JSON.stringify({ inputs: prompt })
      }
    );

    const data = await res.json();
    const output = data[0]?.generated_text;

    try {
      return JSON.parse(output);
    } catch {
      return null;
    }

  } catch {
    return null;
  }
}

/* -------------------------
   FALLBACK (ALWAYS WORKS)
------------------------- */
function fallback(articles) {
  if (articles.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 20,
      reasoning: "No sources found"
    };
  }

  const trusted = articles.some(a =>
    ["bbc","reuters","ap","the hindu"]
      .some(s => a.source?.toLowerCase().includes(s))
  );

  return {
    verdict: trusted ? "Likely Real" : "Unverified",
    confidence: trusted ? 65 : 40,
    reasoning: trusted
      ? "Reported by trusted sources"
      : "Limited coverage"
  };
}

/* -------------------------
   ANALYZE
------------------------- */
async function analyze(text) {
  const articles = await fetchNews(text);

  const ai = await aiCheck(text, articles);

  const result = ai && ai.verdict ? ai : fallback(articles);

  return {
    ...result,
    sources: articles.slice(0, 5)
  };
}

/* -------------------------
   ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 Server running stable");
});

app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.json({
        verdict: "Unverified",
        confidence: 20,
        reasoning: "No input",
        sources: []
      });
    }

    const result = await analyze(text);

    res.json(result);

  } catch (err) {
    console.error("ERROR:", err);

    res.json({
      verdict: "Unverified",
      confidence: 30,
      reasoning: "Server fallback triggered",
      sources: []
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on", PORT));