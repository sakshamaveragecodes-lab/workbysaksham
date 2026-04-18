import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 🔒 Gemini (safe config — no syntax errors)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
    temperature: 0.3,
    topP: 0.9,
    maxOutputTokens: 512
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

// 📰 Fetch news
async function fetchNews(query) {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(
      query
    )}&sortBy=relevancy&language=en&apiKey=${NEWS_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "ok" && data.articles) {
      return data.articles.slice(0, 5);
    }
    return [];
  } catch (err) {
    console.log("News API Error:", err.message);
    return [];
  }
}

// 🧠 Verify engine
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    const sourcesList = articles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source.name
    }));

    const newsContext =
      articles.length > 0
        ? articles.map(a => `- ${a.title} (${a.source.name})`).join("\n")
        : "No reliable articles found.";

    const prompt = `
You are an expert fact-checker.

Claim: "${text}"

News context:
${newsContext}

Rules:
- If multiple trusted sources support → Real
- If clearly false or impossible → Fake
- If unclear → Uncertain

Return ONLY JSON:
{
  "label": "Real" | "Fake" | "Uncertain",
  "confidence": "High" | "Medium" | "Low",
  "reason": "Short explanation"
}
`;

    const result = await model.generateContent(prompt);

    let raw = result.response.text().trim();

    // 🛡️ Clean Gemini output (important)
    raw = raw.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        label: "Uncertain",
        confidence: "Low",
        reason: "AI response parsing failed"
      };
    }

    return {
      label: parsed.label || "Uncertain",
      confidence: parsed.confidence || "Low",
      reason: parsed.reason || "No clear reasoning",
      sources: sourcesList
    };
  } catch (error) {
    console.log("VERIFY ERROR:", error);
    return {
      label: "Error",
      confidence: "None",
      reason: "Server error occurred",
      sources: []
    };
  }
}

// 🚀 ROUTES
app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text || text.length < 5) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Enter proper text",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

app.get("/", (req, res) => {
  res.send("Backend running ✅");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});