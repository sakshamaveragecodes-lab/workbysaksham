import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const cache = new Map();

/* ---------------- LIGHTWEIGHT KNOWLEDGE GRAPH ---------------- */
const knowledgeGraph = new Map();
// format: entity -> { relation -> value }

function updateKG(subject, relation, object, confidence) {
  if (!knowledgeGraph.has(subject)) knowledgeGraph.set(subject, {});
  const node = knowledgeGraph.get(subject);

  if (!node[relation] || node[relation].confidence < confidence) {
    node[relation] = { value: object, confidence };
  }
}

function checkKG(subject, relation, object) {
  const node = knowledgeGraph.get(subject);
  if (!node || !node[relation]) return null;

  if (node[relation].value === object) return "support";
  return "contradict";
}

/* ---------------- QUERY NORMALIZATION ---------------- */
function normalizeQuery(q) {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/* ---------------- ENTITY EXTRACTION ---------------- */
function extractEntities(text) {
  return text.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)+/g) || [];
}

/* ---------------- CLAIM PARSING ---------------- */
function parseClaim(text) {
  const lower = text.toLowerCase();

  const entities = extractEntities(text);
  if (entities.length < 2) return null;

  if (lower.includes("wife")) {
    return {
      subject: entities[0],
      relation: "spouse",
      object: entities[1]
    };
  }

  if (lower.includes("husband")) {
    return {
      subject: entities[0],
      relation: "spouse",
      object: entities[1]
    };
  }

  if (lower.includes("is")) {
    return {
      subject: entities[0],
      relation: "is",
      object: entities[1]
    };
  }

  return null;
}

/* ---------------- FETCH FUNCTIONS ---------------- */
async function fetchGNews(query) {
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&country=in&max=10&apikey=${process.env.GNEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    return data.articles?.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source.name
    })) || [];
  } catch {
    return [];
  }
}

async function fetchMediastack(query) {
  try {
    const url = `http://api.mediastack.com/v1/news?access_key=${process.env.MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&languages=en&limit=10`;
    const res = await fetch(url);
    const data = await res.json();

    return data.data?.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source
    })) || [];
  } catch {
    return [];
  }
}

async function fetchGoogle(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items.map(i => {
      const block = i[1];
      const title = (block.match(/<title>(.*?)<\/title>/)?.[1] || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "");

      const link = block.match(/<link>(.*?)<\/link>/)?.[1] || "";
      const source = title.split(" - ").pop();

      return { title, url: link, source };
    });
  } catch {
    return [];
  }
}

/* ---------------- NLP ---------------- */
function words(text) {
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
}

function similarity(a, b) {
  const w1 = words(a);
  const w2 = words(b);
  const common = w1.filter(w => w2.includes(w)).length;
  return common / Math.max(w1.length, 1);
}

/* ---------------- SOURCE SCORING ---------------- */
function sourceScore(source) {
  const s = source.toLowerCase();

  if (["reuters","bbc","associated press"].some(x => s.includes(x))) return 4;
  if (["the hindu","indian express"].some(x => s.includes(x))) return 3;
  if (["ndtv","times of india"].some(x => s.includes(x))) return 2;

  return 1;
}

/* ---------------- EVIDENCE ANALYSIS ---------------- */
function analyzeEvidence(claim, articles) {
  let support = 0;
  let contradict = 0;

  for (let art of articles) {
    const title = art.title.toLowerCase();

    const hasSubject = title.includes(claim.subject.toLowerCase());
    const hasObject = title.includes(claim.object.toLowerCase());

    if (hasSubject && hasObject) {
      if (title.includes("wife") || title.includes("husband") || title.includes("married")) {
        support++;
      } else {
        contradict++;
      }
    }
  }

  return { support, contradict };
}

/* ---------------- ANALYSIS ---------------- */
function analyze(query, articles) {

  if (!articles.length) {
    return {
      verdict: "Unverified ❓",
      confidence: 20,
      reasoning: "No coverage found",
      sources: []
    };
  }

  const claim = parseClaim(query);

  const ranked = articles.map(a => {
    const relevance = similarity(query, a.title);
    const cred = sourceScore(a.source);
    const score = (relevance * 10) + cred;

    return { ...a, score, relevance, cred };
  })
  .filter(a => a.relevance > 0.1)
  .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      verdict: "Unverified ❓",
      confidence: 25,
      reasoning: "Weak relevance",
      sources: []
    };
  }

  const top = ranked.slice(0, 10);

  /* -------- CLAIM VALIDATION -------- */
  if (claim) {
    const kgCheck = checkKG(claim.subject, claim.relation, claim.object);

    const { support, contradict } = analyzeEvidence(claim, top);

    const confidence = Math.min(95, (support * 15));

    if (kgCheck === "contradict" || contradict > support) {
      return {
        verdict: "Misleading ❌",
        confidence: 80,
        reasoning: "Evidence contradicts the claim",
        sources: top.slice(0, 6)
      };
    }

    if (support >= 3) {
      updateKG(claim.subject, claim.relation, claim.object, confidence);

      return {
        verdict: "Verified ✅",
        confidence,
        reasoning: "Claim supported by multiple sources",
        sources: top.slice(0, 6)
      };
    }
  }

  /* -------- DEFAULT LOGIC -------- */
  const coverage = top.length;
  const avgCred = top.reduce((s, a) => s + a.cred, 0) / coverage;

  if (coverage >= 5 && avgCred >= 2.5) {
    return {
      verdict: "Likely Real 👍",
      confidence: 85,
      reasoning: "Consistent coverage across sources",
      sources: top.slice(0, 6)
    };
  }

  return {
    verdict: "Unverified ❓",
    confidence: 40,
    reasoning: "Insufficient reliable agreement",
    sources: top.slice(0, 6)
  };
}

/* ---------------- ROUTE ---------------- */
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.json({
        verdict: "Unverified ❓",
        confidence: 0,
        reasoning: "Empty input",
        sources: []
      });
    }

    if (cache.has(text)) return res.json(cache.get(text));

    const query = normalizeQuery(text);

    const [gnews, mediastack, google] = await Promise.all([
      fetchGNews(query),
      fetchMediastack(query),
      fetchGoogle(query)
    ]);

    const allArticles = [...gnews, ...mediastack, ...google];

    const result = analyze(query, allArticles);

    cache.set(text, result);
    res.json(result);

  } catch {
    res.json({
      verdict: "Unverified ❓",
      confidence: 10,
      reasoning: "Server error",
      sources: []
    });
  }
});

app.listen(PORT, () => {
  console.log("🚀 Veritas AI upgraded with KG + claim validation");
});