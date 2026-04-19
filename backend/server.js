import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ENV
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;

if (!NEWS_API_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing API keys");
}

// Gemini setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { temperature: 0.2 }
});


// 🔍 KEYWORD EXTRACTION
function extractKeywords(text) {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .toLowerCase()
    .split(" ")
    .filter(w => w.length > 2)
    .slice(0, 10)
    .join(" ");
}


// 📰 FETCH NEWS
async function fetchNews(query) {
  try {
    const urls = [
      `https://newsapi.org/v2/everything?q=${query}&sortBy=relevancy&pageSize=5&apiKey=${NEWS_API_KEY}`,
      `https://newsapi.org/v2/top-headlines?q=${query}&pageSize=5&apiKey=${NEWS_API_KEY}`
    ];

    let results = [];

    for (const url of urls) {
      const res = await fetch(url);
      const data = await res.json();

      if (data.status === "ok") {
        results.push(...data.articles);
      } else {
        console.error("News API Error:", data);
      }
    }

    return results.map(a => ({
      title: a.title,
      description: a.description,
      url: a.url,
      source: a.source?.name
    }));

  } catch (err) {
    console.error("News fetch error:", err.message);
    return [];
  }
}


// 🌐 GOOGLE SEARCH
async function fetchGoogleResults(query) {
  try {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];

    const url = `https://www.googleapis.com/customsearch/v1?q=${query}&key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}`;
    const res = await fetch(url);
    const data = await res.json();

    return data.items?.map(item => ({
      title: item.title,
      description: item.snippet,
      url: item.link,
      source: item.displayLink
    })) || [];

  } catch (err) {
    console.error("Google fetch error:", err.message);
    return [];
  }
}


// ⚖️ SCORING ENGINE (CORE ACCURACY)
function scoreClaim(evidence, text) {
  let score = 0;
  const claim = text.toLowerCase();

  evidence.forEach(e => {
    const content = (e.title + " " + (e.description || "")).toLowerCase();

    if (content.includes(claim.slice(0, 20))) score += 2;

    if (content.includes("false") || content.includes("fake") || content.includes("hoax")) score -= 2;

    if (content.includes("confirmed") || content.includes("official")) score += 1;
  });

  return score;
}


// 🎯 VERDICT
function getVerdict(score) {
  if (score >= 3) return { label: "Real", confidence: "High" };
  if (score <= -3) return { label: "Fake", confidence: "High" };
  if (score > 0) return { label: "Real", confidence: "Medium" };
  if (score < 0) return { label: "Fake", confidence: "Medium" };
  return { label: "Uncertain", confidence: "Low" };
}


// 🚫 NON-FACT CHECKABLE DETECTION
function isVerifiable(text) {
  const vague = ["maybe", "might", "could", "opinion", "think"];
  return !vague.some(w => text.toLowerCase().includes(w));
}


// 🧠 MAIN VERIFY FUNCTION
async function verifyNews(text) {
  try {
    if (!isVerifiable(text)) {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "This claim is not fact-checkable.",
        sources: []
      };
    }

    const query = extractKeywords(text);

    const news = await fetchNews(query);
    const google = await fetchGoogleResults(query);

    const evidence = [...news, ...google].slice(0, 8);

    if (evidence.length === 0) {
      return {
        label: "Uncertain",
        confidence: "Low",
        reason: "No reliable sources found.",
        sources: []
      };
    }

    const score = scoreClaim(evidence, text);
    const { label, confidence } = getVerdict(score);

    // 🧠 AI ONLY FOR EXPLANATION
    const prompt = `
    Claim: "${text}"
    Verdict: ${label}

    Evidence:
    ${JSON.stringify(evidence)}

    Explain briefly why this verdict is correct based only on evidence.
    `;

    let explanation = "No explanation available";

    try {
      const aiRes = await model.generateContent(prompt);
      explanation = aiRes.response.text();
    } catch {
      explanation = "Explanation could not be generated.";
    }

    return {
      label,
      confidence,
      reason: explanation,
      sources: evidence
    };

  } catch (err) {
    console.error("VERIFY ERROR:", err.message);

    return {
      label: "Error",
      confidence: "None",
      reason: "Server error during verification.",
      sources: []
    };
  }
}


// 🌐 ROUTES
app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});

app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text || text.trim().length < 5) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Enter a proper claim.",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});


// 🚀 START SERVER
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log("🚀 Server running on port " + PORT));