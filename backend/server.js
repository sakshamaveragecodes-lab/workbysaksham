import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ✅ Gemini setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
    temperature: 0.3
  }
});

// 🔍 Clean query
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .filter(w => w.length > 2)
    .slice(0, 6)
    .join(" ");
}

// 📰 Fetch news (using built-in fetch — no node-fetch)
async function fetchNews(query) {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "ok") {
      return data.articles.slice(0, 5);
    }

    return [];
  } catch (err) {
    console.log("NEWS ERROR:", err.message);
    return [];
  }
}

// 🧠 Verify
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    const sources = articles.map(a => ({
      title: a.title,
      url: a.url
    }));

    const context = articles.length
      ? articles.map(a => a.title).join("\n")
      : "No articles found";

    const prompt = `
Check this claim: "${text}"

Context:
${context}

Return JSON:
{
 "label": "Real/Fake/Uncertain",
 "confidence": "High/Medium/Low",
 "reason": "Short explanation"
}
`;

    const result = await model.generateContent(prompt);

    let raw = result.response.text().replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "AI format issue",
        sources
      };
    }

    return {
      label: parsed.label,
      confidence: parsed.confidence,
      reason: parsed.reason,
      sources
    };

  } catch (err) {
    console.log("VERIFY ERROR:", err);
    return {
      label: "Error",
      confidence: "None",
      reason: "Server failed",
      sources: []
    };
  }
}

// 🚀 Routes
app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "No input",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});