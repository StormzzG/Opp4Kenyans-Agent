import { CohereClientV2 } from "cohere-ai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// ---------- CONFIG ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const TOP_K = 5;

const cohere = new CohereClientV2({
  token: COHERE_API_KEY,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- HELPER: LEGAL FILTER ----------
const LEGAL_URLS = ["/terms", "/privacy-policy"];
function isLegalChunk(url, question) {
  const path = String(url).replace("https://opportunitiesforkenyans.live", "").toLowerCase();
  const q = String(question).toLowerCase();
  if (LEGAL_URLS.some(u => path.includes(u))) {
    if (q.includes("term") || q.includes("privacy") || q.includes("policy")) return false;
    return true;
  }
  return false;
}

// ---------- GET EMBEDDING ----------
async function getEmbedding(text) {
  try {
    const response = await cohere.embed({
      model: "embed-english-v3.0",
      texts: [text],
      inputType: "search_query",        // ← Changed to camelCase (important!)
      embeddingTypes: ["float"],        // ← Also changed to camelCase
    });

    let embedding;

    if (response.embeddings?.float?.[0]) {
      embedding = response.embeddings.float[0];
    } else if (Array.isArray(response.embeddings) && response.embeddings[0]) {
      embedding = response.embeddings[0];
    } else if (response.embeddings?.float?.length > 0) {
      embedding = response.embeddings.float[0];
    }

    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("No valid embedding vector returned from Cohere");
    }

    return embedding;
  } catch (err) {
    console.error("Cohere embedding error:", err.message || err);
    if (err.errors) console.error("Cohere errors:", err.errors);
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

// ---------- CALL LLM (Cohere) ----------
async function callLLM(question, contextText) {
  const systemPrompt = `
You are a friendly, helpful assistant for Opportunities for Kenyans.

Rules you MUST follow:
- Only answer using information clearly present in the provided CONTEXT.
- If the question is a simple greeting and CONTEXT has any welcoming or introductory text, reply warmly.
- If no relevant information exists in CONTEXT to answer the question meaningfully, reply EXACTLY:
"That information is not available on the Opportunities for Kenyans website at the moment. Please contact our team for more support at: opp4kenyans@gmail.com"

Be warm, concise, professional and encouraging. Use "we" and "our platform" naturally when appropriate.
Never invent facts or use external knowledge.
`;

  try {
    const response = await cohere.chat({
      model: "command-r-plus",           // Best current model (change to "command-r" if cheaper needed)
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `CONTEXT:\n${contextText || "(No relevant website content found)"}\n\nQUESTION: ${question}` }
      ],
      temperature: 0.2,
      max_tokens: 550,
    });

    return (response.text || response.message?.content?.[0]?.text || "").trim();
  } catch (err) {
    console.error("Cohere chat error:", err.message);
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
    // Greeting Detector (Time-aware)
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
      const hour = new Date().getHours();

      let warmReply = "Hello! Welcome to Opportunities for Kenyans 😊 How can I help you today?";

      if (hour >= 5 && hour < 12) warmReply = "Good morning! Welcome to Opportunities for Kenyans 🌞 How can I assist you?";
      else if (hour >= 12 && hour < 17) warmReply = "Good afternoon! Welcome to Opportunities for Kenyans ☀️ What’s on your mind?";
      else warmReply = "Good evening! Welcome to Opportunities for Kenyans 🌙 How can I support you?";

      // Log greeting
      try {
        await supabase.from("chat_history").insert([
          { user_message: question, assistant_message: warmReply }
        ]);
      } catch (err) {
        console.error("Greeting history insert error:", err);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ answer: warmReply, sources: [] })
      };
    }

    // ────────────────────────────────────────────────────────────────
    // Normal RAG Flow
    // ────────────────────────────────────────────────────────────────
    const embedding = await getEmbedding(question);
    const chunks = await retrieveChunks(embedding, question);

    const contextText = chunks.length > 0
      ? chunks.map(c => `From ${c.url}:\n${c.chunk}`).join("\n\n---\n\n")
      : "";

    const answer = await callLLM(question, contextText);

    // Log conversation
    try {
      await supabase.from("chat_history").insert([
        { user_message: question, assistant_message: answer }
      ]);
    } catch (err) {
      console.error("Chat history insert error:", err);
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
