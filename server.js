import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
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
   🌐 FETCH NEWS (ROBUST)
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
        source: a.source?.name || "Unknown"
      })),
      ...mediastack.map(a => ({
        title: a.title,
        desc: a.description,
        url: a.url,
        source: a.source
      }))
    );
  }

  // dedupe
  const seen = new Set();
  return results.filter(a => {
    const key = a.title?.toLowerCase().slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------
   🧠 LLM (STRICT JSON MODE)
------------------------- */
async function runLLM(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

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
          parameters: { max_new_tokens: 200 }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const data = await res.json();
    return data[0]?.generated_text || "";

  } catch {
    return null;
  }
}

/* -------------------------
   🧠 FACT CHECK CORE
------------------------- */
async function factCheck(text, articles) {

  const context = articles
    .slice(0, 5)
    .map((a, i) =>
      `(${i + 1}) ${a.title} | ${a.source}`
    )
    .join("\n");

  const prompt = `
You are a professional fact checker.

CLAIM:
"${text}"

EVIDENCE:
${context}

Return STRICT JSON:
{
 "verdict": "Real or Fake or Misleading or Unverified",
 "confidence": number (0-100),
 "reasoning": "short explanation"
}

Rules:
- Use evidence agreement
- Penalize weak or single sources
- Detect exaggeration
- Be conservative if unsure
`;

  const output = await runLLM(prompt);

  if (!output) {
    return {
      verdict: "Unverified",
      confidence: 40,
      reasoning: "AI unavailable"
    };
  }

  try {
    const json = JSON.parse(output);
    return json;
  } catch {
    return {
      verdict: "Unverified",
      confidence: 50,
      reasoning: output.slice(0, 200)
    };
  }
}

/* -------------------------
   📊 ANALYZE
------------------------- */
async function analyze(text) {

  const articles = await fetchNews(text);

  if (articles.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 20,
      reasoning: "No sources found",
      sources: []
    };
  }

  const result = await factCheck(text, articles);

  return {
    ...result,
    sources: articles.slice(0, 5)
  };
}

/* -------------------------
   🚀 ROUTES
------------------------- */
app.get("/", (req, res) => {
  res.send("🚀 Hybrid V3 Running");
});

app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "No input" });
    }

    const result = await analyze(text);
    res.json(result);

  } catch (err) {
    res.status(500).json({
      error: "Failed",
      details: err.message
    });
  }
});

/* ------------------------- */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});