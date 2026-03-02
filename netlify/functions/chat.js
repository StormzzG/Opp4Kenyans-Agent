import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// ---------- CONFIG ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const EMBED_MODEL = "togethercomputer/m2-bert-80M-32k-retrieval";
const LLM_MODEL = "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
const TOP_K = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- HELPER: LEGAL FILTER ----------
const LEGAL_URLS = ["/terms", "/privacy-policy"];
function isLegalChunk(url, question) {
  const path = String(url).replace("https://opportunitiesforkenyans.live", "").toLowerCase();
  const q = String(question).toLowerCase();
  if (LEGAL_URLS.some(u => path.includes(u))) {
    if (q.includes("term") || q.includes("privacy") || q.includes("policy")) return false; // include if asking about it
    return true; // skip otherwise
  }
  return false;
}

// ---------- EMBEDDING ----------
async function getEmbedding(text) {
  const safeText = typeof text === "string" ? text.trim() : String(text);
  try {
    const resp = await axios.post(
      "https://api.together.xyz/v1/embeddings",
      {
        model: EMBED_MODEL,
        input: safeText
      },
      {
        headers: {
          Authorization: `Bearer ${TOGETHER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    return resp.data.data[0].embedding;
  } catch (err) {
    console.error("Embedding error:", err.message);
    throw err;
  }
}

// ---------- RETRIEVAL ----------
async function retrieveChunks(queryEmbedding, question) {
  const { data, error } = await supabase.rpc("match_website_embeddings", {
    query_embedding: queryEmbedding,
    match_count: TOP_K * 3,
  });

  if (error || !data) {
    console.error("Supabase error:", error);
    return [];
  }

  const filtered = data.filter(c => !isLegalChunk(c.url, question));
  filtered.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  return filtered.slice(0, TOP_K);
}

// ---------- CALL LLM ----------
async function callLLM(question, contextText) {
  const messages = [
    {
      role: "system",
      content: `
You are a friendly, helpful assistant for Opportunities for Kenyans.

Rules:
- Only answer using information clearly present in the provided CONTEXT.
- If the question is a simple greeting and CONTEXT has any welcoming/introductory text, reply warmly.
- If no relevant information exists in CONTEXT to answer meaningfully, reply EXACTLY:
"That information is not available on the Opportunities for Kenyans website at the moment. Please contact our team for more support at: opp4kenyans@gmail.com"

Be warm, concise, professional, encouraging. Use "we", "our platform" when appropriate.
Never invent facts.
      `
    },
    {
      role: "user",
      content: `CONTEXT:\n${contextText || "(No relevant website content found)"}\n\nQUESTION: ${question}\nAnswer now:`
    }
  ];

  try {
    const resp = await axios.post(
      "https://api.together.xyz/v1/chat/completions",
      {
        model: LLM_MODEL,
        messages,
        temperature: 0.2,     // slightly higher than 0.15 for friendlier tone
        max_tokens: 500,
      },
      { headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` } }
    );

    return resp.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("LLM error:", err.message);
    return "Sorry, I'm having trouble responding right now.";
  }
}

// ---------- NETLIFY FUNCTION ----------
export async function handler(event, context) {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const question = body.question?.trim();

    if (!question) {
      return { statusCode: 400, body: JSON.stringify({ error: "Question missing." }) };
    }

    // ────────────────────────────────────────────────────────────────
    // Greeting detector – time-aware + more patterns (like local version)
    // ────────────────────────────────────────────────────────────────
    const questionLower = question.toLowerCase();
    const greetingPatterns = [
      /^hi|hello|hey|salam|habari|jambo|greetings$/i,
      /^good (morning|afternoon|evening)$/i
    ];

    const isSimpleGreeting = questionLower.length < 40 &&
      greetingPatterns.some(p => p.test(questionLower)) &&
      !questionLower.includes("?") &&
      !questionLower.includes("what") &&
      !questionLower.includes("where") &&
      !questionLower.includes("how");

    if (isSimpleGreeting) {
      const hour = new Date().getHours(); // EAT time

      let warmReply = "Hello! Welcome to Opportunities for Kenyans 😊 How can I help you today?";

      if (hour >= 5 && hour < 12) {
        warmReply = "Good morning! Welcome to Opportunities for Kenyans 🌞 How can I assist you?";
      } else if (hour >= 12 && hour < 17) {
        warmReply = "Good afternoon! Welcome to Opportunities for Kenyans ☀️ What’s on your mind?";
      } else {
        warmReply = "Good evening! Welcome to Opportunities for Kenyans 🌙 How can I support you?";
      }

      // Save to chat history
      try {
        const { error } = await supabase.from("chat_history").insert([
          { user_message: question, assistant_message: warmReply }
        ]);
        if (error) console.error("Greeting history insert error:", error);
      } catch (err) {
        console.error("Unexpected error logging greeting:", err);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          answer: warmReply,
          sources: []
        })
      };
    }

    // ────────────────────────────────────────────────────────────────
    // Normal flow
    // ────────────────────────────────────────────────────────────────

    const embedding = await getEmbedding(question);
    const chunks = await retrieveChunks(embedding, question);

    let contextText = "";
    if (chunks.length > 0) {
      contextText = chunks.map(c => `From ${c.url}:\n${c.chunk}`).join("\n\n---\n\n");
    }

    const answer = await callLLM(question, contextText);

    // Save to chat history
    try {
      const { error } = await supabase.from("chat_history").insert([
        { user_message: question, assistant_message: answer }
      ]);
      if (error) console.error("Failed to store chat history:", error);
    } catch (err) {
      console.error("Unexpected error logging chat:", err);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        answer,
        sources: chunks.map(c => c.url)
      })
    };
  } catch (err) {
    console.error("Server error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server failed." })
    };
  }
}
