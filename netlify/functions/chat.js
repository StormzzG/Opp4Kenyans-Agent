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
const TOP_K = 5; // number of chunks to return

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- HELPER: LEGAL FILTER ----------
const LEGAL_URLS = ["/terms", "/privacy-policy"];
function isLegalChunk(url, question) {
  const path = String(url).replace("https://opportunitiesforkenyans.live", "").toLowerCase();
  const q = String(question).toLowerCase();
  if (LEGAL_URLS.some(u => path.includes(u))) {
    if (q.includes("term") || q.includes("privacy")) return false; // include
    return true; // skip
  }
  return false; // normal chunk
}

// ---------- EMBEDDING ----------
async function getEmbedding(text) {
  const resp = await axios.post(
    "https://api.together.xyz/v1/embeddings",
    { model: EMBED_MODEL, input: [text] },
    { headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` } }
  );
  return resp.data.data[0].embedding;
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
You are the Opportunities for Kenyans AI assistant.
Only answer using the provided context chunks.
If the context does not contain the answer, reply exactly:
"That information is not available on the Opportunities for Kenyans website at the moment. Please contact our team for more support at: opp4kenyans@gmail.com"
Speak confidently using "we", "our platform", etc.
`
    },
    {
      role: "user",
      content: `CONTEXT:\n${contextText}\n\nQUESTION: ${question}\nAnswer concisely using only the CONTEXT.`
    }
  ];

  const resp = await axios.post(
    "https://api.together.xyz/v1/chat/completions",
    {
      model: LLM_MODEL,
      messages,
      temperature: 0.15,
      max_tokens: 450,
    },
    { headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` } }
  );

  return resp.data.choices[0].message.content.trim();
}

// ---------- NETLIFY FUNCTION ----------
export async function handler(event, context) {
  try {
    const { question } = JSON.parse(event.body || "{}");

    if (!question) {
      return { statusCode: 400, body: JSON.stringify({ error: "Question missing." }) };
    }

    // 1. Generate embedding
    const embedding = await getEmbedding(question);

    // 2. Retrieve chunks
    const chunks = await retrieveChunks(embedding, question);

    // 3. Prepare context text
    let contextText = "";
    if (chunks.length > 0) {
      contextText = chunks.map(c => `From ${c.url}:\n${c.chunk}`).join("\n\n---\n\n");
    }

    // 4. Get answer from LLM
    const answer = await callLLM(question, contextText);

    // 5. Save memory in Supabase
    const { error: insertError } = await supabase.from("chat_history").insert([
      { user_message: question, assistant_message: answer }
    ]);

    if (insertError) {
      console.error("Failed to store chat history:", insertError);
    }

    // 6. Return response
    return {
      statusCode: 200,
      body: JSON.stringify({ answer, sources: chunks.map(c => c.url) })
    };

  } catch (err) {
    console.error("Server error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Server failed." }) };
  }
}
