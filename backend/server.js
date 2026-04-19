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
    temperature: 0.1 // Lowered further for maximum factual strictness
  }
});

// Clean input
function cleanQuery(text) {
  const stopwords = new Set(["about","after","all","also","and","any","are","because","been","before","being","between","both","but","can","could","did","does","even","for","from","further","had","has","have","here","how","into","just","like","made","many","more","most","much","must","not","only","other","our","out","over","said","same","see","should","since","some","such","than","that","the","their","them","then","there","these","they","this","those","through","too","under","until","upon","very","was","well","were","what","when","where","which","while","who","will","with","would","you","your","according","reports","claims","stated","true","false","fake","real","news","is","it"]);

  return text
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !stopwords.has(w))
    .slice(0, 3) 
    .join(" ");
}

// Fetch news (Added explicit error logging to catch NewsAPI silent fails)
async function fetchNews(query) {
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=relevancy&language=en&pageSize=10&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "error") {
      console.error("🚨 NEWSAPI CATCH IDENTIFIED:", data.message);
      return [];
    }

    if (data.status === "ok") {
      return data.articles.filter(a => a.title && !a.title.includes("[Removed]"));
    }
    return [];
  } catch (err) {
    console.error("🚨 FETCH NEWS ERROR:", err.message);
    return [];
  }
}

// Verify news (Prompt Un-handcuffed & Bulletproof JSON Parser)
async function verifyNews(text) {
  try {
    const query = cleanQuery(text);
    const articles = await fetchNews(query);

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

    const context = finalArticles.length
      ? finalArticles.map(a => `Source: ${a.source?.name}\nTitle: ${a.title}\nSummary: ${a.description || "No summary available"}`).join("\n\n")
      : "No current news evidence found for this specific query.";

    const sources = finalArticles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || "Unknown"
    }));

    // THE FIX: The prompt now allows Gemini to use its own brain if NewsAPI fails
    const prompt = `
You are a highly strict, expert fact-checking AI.

Claim to Verify:
"${text}"

Available News Evidence:
${context}

Rules:
1. First, check the Available News Evidence. If it explicitly supports or debunks the claim, base your answer on that.
2. THE CATCH: If the Available News Evidence says "No current news evidence found" OR is completely unrelated to the claim, you MUST use your own internal verified historical knowledge to fact-check the claim.
3. Be decisive. Label as "Real" or "Fake" if you know the answer. 
4. ONLY output "Uncertain" if the claim is highly subjective, an unprovable prediction, or total gibberish.

Return ONLY a raw JSON object. Do not include markdown blocks. Use this exact structure:
{
  "analysis": "Internal reasoning step",
  "label": "Real" | "Fake" | "Uncertain",
  "reason": "A crisp, definitive 1-2 sentence explanation for the user."
}
`;

    let parsed;

    try {
      const result = await model.generateContent(prompt);
      const raw = result.response.text();
      
      // BULLETPROOF JSON EXTRACTOR: Finds the JSON object even if hidden inside text
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON object found in AI response");
      }
      
    } catch (parseErr) {
      console.error("🚨 JSON PARSE CATCH:", parseErr);
      parsed = {
        label: "Uncertain",
        reason: "The AI encountered an error processing the verification data."
      };
    }

    return {
      label: parsed.label || "Uncertain",
      confidence: finalArticles.length >= 3 ? "High" : "Medium",
      reason: parsed.reason || "Analysis completed",
      sources
    };

  } catch (err) {
    console.error("VERIFY ERROR:", err);
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
app.listen(PORT, () => console.log("🚀 Server running on port " + PORT));