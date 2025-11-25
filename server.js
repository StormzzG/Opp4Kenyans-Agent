import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
  const path = url.replace("https://opportunitiesforkenyans.live", "").toLowerCase();
  const q = question.toLowerCase();
  if (LEGAL_URLS.some(u => path.includes(u))) {
    // include only if question mentions "term" or "privacy"
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
  // retrieve extra to allow filtering
  const { data, error } = await supabase.rpc("match_website_embeddings", {
    query_embedding: queryEmbedding,
    match_count: TOP_K * 3,
  });

  if (error || !data) {
    console.error("Supabase error:", error);
    return [];
  }

  // filter out legal pages unless explicitly asked
  const filtered = data.filter(c => !isLegalChunk(c.url, question));

  // sort by similarity descending
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

// ---------- MAIN ENDPOINT WITH MEMORY ----------
app.post("/chat", async (req, res) => {
  try {
    const question = req.body.question;
    if (!question) return res.status(400).json({ error: "Question missing." });

    // 1. Generate embedding for question
    const embedding = await getEmbedding(question);

    // 2. Retrieve matching chunks
    const chunks = await retrieveChunks(embedding, question);

    let contextText = "";
    if (chunks.length > 0) {
      contextText = chunks
        .map((c) => `From ${c.url}:\n${c.chunk}`)
        .join("\n\n---\n\n");
    }

    // 3. Get answer from LLM
    const answer = await callLLM(question, contextText);

    // 4. SAVE memory into Supabase
    const { error: insertError } = await supabase
      .from("chat_history")
      .insert([
        {
          user_message: question,
          assistant_message: answer
        }
      ]);

    if (insertError) {
      console.error("Failed to store chat history:", insertError);
    }

    // 5. Return chatbot response to front-end
    res.json({
      answer,
      sources: chunks.map((c) => c.url)
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Server failed." });
  }
});


// ---------- START SERVER ----------
app.listen(3000, () => {
  console.log("💬 AI Agent running on http://localhost:3000");
});
