import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Safety check
if (!NEWS_API_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing API keys");
}

// Gemini setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash"
});

// Clean input
function cleanQuery(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .slice(0, 6)
    .join(" ");
}

// Fetch news
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
    console.log("News error:", err.message);
    return [];
  }
}

// Verify news
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    const context = articles.length
      ? articles.map(a => a.title).join("\n")
      : "No articles found";

    const sources = articles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));

    let aiResponse = "";

    try {
      const result = await model.generateContent(
        `Check this claim: "${text}"
Context:
${context}

Answer in ONE word: Real, Fake, or Uncertain.
Also give 1 short reason.`
      );

      aiResponse = result.response.text();
    } catch {
      aiResponse = "Uncertain - AI failed";
    }

    let label = "Uncertain";
    if (aiResponse.toLowerCase().includes("real")) label = "Real";
    else if (aiResponse.toLowerCase().includes("fake")) label = "Fake";

    return {
      label,
      confidence: "Medium",
      reason: aiResponse,
      sources
    };

  } catch (err) {
    console.log("Verify error:", err);
    return {
      label: "Error",
      confidence: "None",
      reason: "Server failed",
      sources: []
    };
  }
}

// Routes
app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});

app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "No input provided",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("🚀 Server running"));