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

if (!NEWS_API_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing API keys");
}

// Gemini setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.2
  }
});

// Clean input (Optimized to top 3 keywords so NewsAPI doesn't return 0 results)
function cleanQuery(text) {
  const stopwords = new Set(["about","after","all","also","and","any","are","because","been","before","being","between","both","but","can","could","did","does","even","for","from","further","had","has","have","here","how","into","just","like","made","many","more","most","much","must","not","only","other","our","out","over","said","same","see","should","since","some","such","than","that","the","their","them","then","there","these","they","this","those","through","too","under","until","upon","very","was","well","were","what","when","where","which","while","who","will","with","would","you","your","according","reports","claims","stated","true","false","fake","real","news","is","it"]);

  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !stopwords.has(w))
    .slice(0, 3) // Changed to 3: Prevents NewsAPI from failing due to overly strict matching
    .join(" ");
}

// Fetch news
async function fetchNews(query) {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=relevancy&language=en&pageSize=10&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "ok") {
      return data.articles.filter(a => a.title && !a.title.includes("[Removed]"));
    }
    return [];
  } catch (err) {
    console.log("News error:", err.message);
    return [];
  }
}

// Verify news (Now feeds the article DESCRIPTION to Gemini, not just the title)
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

    // Remove duplicates + weak titles
    const unique = [];
    const seen = new Set();

    for (let a of articles) {
      const key = a.title?.toLowerCase();
      if (key && !seen.has(key) && a.title.length > 20) {
        seen.add(key);
        unique.push(a);
      }
    }

    const finalArticles = unique.slice(0, 5);

    // CRITICAL FIX: Passing a.description so Gemini actually knows the facts
    const context = finalArticles.length
      ? finalArticles.map(a => `Source: ${a.source?.name}\nTitle: ${a.title}\nSummary: ${a.description || "No summary available"}`).join("\n\n")
      : "No reliable news found";

    const sources = finalArticles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));

    const prompt = `
You are a highly strict, expert fact-checking AI.

Claim to Verify:
"${text}"

Available News Evidence:
${context}

Rules:
1. Read the Titles AND Summaries provided in the evidence.
2. If the summaries explicitly support the core claim -> label: "Real"
3. If the summaries explicitly debunk, contradict, or call the claim a hoax -> label: "Fake"
4. Be decisive. Do not default to "Uncertain" if the summary gives you a clear answer.
5. Only output "Uncertain" if the evidence is completely empty or totally unrelated to the claim.
6. Do NOT rely on your internal training data.

Return ONLY a raw JSON object with no markdown formatting and no backticks. Use this exact structure:
{
  "analysis": "Briefly evaluate the evidence internally here before deciding",
  "label": "Real" | "Fake" | "Uncertain",
  "reason": "A crisp, 1-2 sentence explanation for the user based on the evidence"
}
`;

    let parsed;

    try {
      const result = await model.generateContent(prompt);
      let raw = result.response.text();
      
      // Strip markdown code blocks
      raw = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.log("JSON Parse Failed:", parseErr);
      parsed = {
        label: "Uncertain",
        reason: "The evidence was too ambiguous to format a confident response."
      };
    }

    return {
      label: parsed.label || "Uncertain",
      confidence: finalArticles.length >= 3 ? "High" : "Medium",
      reason: parsed.reason || "Analysis completed",
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

// Routes
app.get("/", (req, res) => {
  res.send("Backend Running ✅");
});

app.post("/check-news", async (req, res) => {
  const { text } = req.body;

  if (!text || text.length < 5) {
    return res.json({
      label: "Uncertain",
      confidence: "Low",
      reason: "Enter a valid claim",
      sources: []
    });
  }

  const result = await verifyNews(text);
  res.json(result);
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("🚀 Server running"));