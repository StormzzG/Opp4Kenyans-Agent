// CHANGE THIS to your backend endpoint when deployed
// during local dev use http://localhost:3000/chat
const BACKEND_URL = "http://localhost:3000/chat";

const messagesDiv = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const minimizeBtn = document.getElementById("minimize-btn");
const chatApp = document.querySelector(".chat-app");

// helper to append messages
function appendMessage(text, role = "bot") {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = text;
  messagesDiv.appendChild(el);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// add typing indicator
function addTyping() {
  const wrapper = document.createElement("div");
  wrapper.className = "message bot typing";
  wrapper.id = "typing-indicator";
  wrapper.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesDiv.appendChild(wrapper);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
function removeTyping() {
  const t = document.getElementById("typing-indicator");
  if (t) t.remove();
}

// initial greeting
appendMessage("Hello! I'm the Opportunities for Kenyans assistant. Ask me about Kazi Mtaani, Money Market Fund, or Fractional Real Estate.", "bot");

// form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  appendMessage(text, "user");
  input.value = "";
  addTyping();

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text })
    });
    const data = await res.json();

    removeTyping();

    // If your backend returns { answer } or { answer, sources }
    const answer = (data && (data.answer || data.data || data.text)) || "Sorry, no response.";
    appendMessage(answer, "bot");
  } catch (err) {
    removeTyping();
    appendMessage("Error connecting to server. Try again later.", "bot");
    console.error("Chat error:", err);
  }
});

// minimize button toggles view
minimizeBtn.addEventListener("click", () => {
  // collapse the UI into a compact header
  if (chatApp.classList.contains("min")) {
    chatApp.classList.remove("min");
    // restore full size
    messagesDiv.style.display = "block";
    form.style.display = "flex";
  } else {
    chatApp.classList.add("min");
    messagesDiv.style.display = "none";
    form.style.display = "none";
  }
});
