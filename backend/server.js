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

// ❗ Safety check (prevents silent crashes)
if (!NEWS_API_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing API keys in environment variables");
}

// ✅ Gemini setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.3,
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
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "ok") return data.articles.slice(0, 5);
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

    const context = articles.length
      ? articles.map(a => a.title).join("\n")
      : "No articles found";

    const sources = articles.map(a => ({
      title: a.title,
      url: a.url
    }));

    const prompt = `
Check this claim: "${text}"

Context:
${context}

Return:
Label (Real/Fake/Uncertain)
Reason (short)
`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    return {
      label: response.includes("Real")
        ? "Real"
        : response.includes("Fake")
        ? "Fake"
        : "Uncertain",
      confidence: "Medium",
      reason: response,
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

// 🚀 Route
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
  console.log("🚀 Server running on port", PORT);
});