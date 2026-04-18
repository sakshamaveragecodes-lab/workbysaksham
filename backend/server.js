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

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Upgrade: Forcing strict JSON output from Gemini to prevent parsing crashes
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",
  generationConfig: { responseMimeType: "application/json" }
});

// 🔍 Smarter Clean Input
function cleanQuery(text) {
  // Removes special characters but keeps numbers and letters, takes first 6 words for better API matching
  return text.replace(/[^a-zA-Z0-9 ]/g, "").split(" ").slice(0, 6).join(" ");
}

// 📰 Fetch News with fallback
async function fetchNews(query) {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=relevancy&language=en&apiKey=${NEWS_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "ok" && data.articles) {
      return data.articles.slice(0, 5); // Return top 5 most relevant
    }
    return [];
  } catch (error) {
    console.error("NewsAPI Error:", error.message);
    return [];
  }
}

// 🧠 Verify Core Engine
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    const sourcesList = articles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source.name
    }));

    const newsContext = articles.length > 0 
      ? articles.map(a => `- ${a.title} (${a.source.name})`).join("\n") 
      : "No live news articles found. Base your judgment on general factual knowledge and logic.";

    const prompt = `
      You are an expert, highly accurate fact-checker. 
      Analyze this claim: "${text}"

      Live News Context:
      ${newsContext}

      Rules:
      1. Cross-reference the claim with the Live News Context.
      2. If the claim is demonstrably false, label it "Fake".
      3. If it is verified by trusted sources, label it "Real".
      4. If there is not enough evidence, label it "Uncertain".
      5. Provide a clear, objective 2-sentence reason.

      Respond ONLY with this JSON structure:
      {
        "label": "Real" | "Fake" | "Uncertain",
        "confidence": "High" | "Medium" | "Low",
        "reason": "Your objective explanation here."
      }
    `;

    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());

    return {
      label: parsed.label || "Uncertain",
      confidence: parsed.confidence || "Low",
      reason: parsed.reason || "Analysis completed, but confidence is low.",
      sources: sourcesList
    };

  } catch (error) {
    console.error("Verification Engine Error:", error);
    return {
      label: "Error",
      confidence: "None",
      reason: "The verification engine encountered a system error. Please try again.",
      sources: []
    };
  }
}

// ROUTES
app.post("/check-news", async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 5) {
    return res.status(400).json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Please enter a valid, longer claim to analyze.",
      sources: []
    });
  }
  const result = await verifyNews(text);
  res.json(result);
});

app.get("/", (req, res) => res.send("✅ Intelligence Core Online"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT} 🚀`));