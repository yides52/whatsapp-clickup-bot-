import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
 
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
 
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
const conversations = {};
const MAX_HISTORY = 20;
 
// All Bolted Iron Sales lists (except Leads)
const LISTS = [
  { name: "Proposals", id: "901413446200" },
  { name: "Josh Proposals", id: "901413557769" },
  { name: "Sales To Follow", id: "901413446202" },
  { name: "Job Status", id: "901413446203" },
];
 
async function clickup(method, path, body = null) {
  const res = await axios({
    method,
    url: `https://api.clickup.com/api/v2${path}`,
    headers: {
      Authorization: process.env.CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
    },
    data: body || undefined,
  });
  return res.data;
}
 
// Search all lists for tasks matching a query
async function searchTasks(query) {
  const q = query.toLowerCase();
  let matches = [];
  for (const list of LISTS) {
    let page = 0;
    while (true) {
      const data = await clickup("GET", `/list/${list.id}/task?page=${page}`);
      if (!data.tasks?.length) break;
      for (const t of data.tasks) {
        if (t.name.toLowerCase().includes(q)) {
          matches.push({ id: t.id, name: t.name, list: list.name });
        }
      }
      if (!data.last_page) page++;
      else break;
    }
  }
  return matches;
}
 
async function postComment(taskId, comment) {
  await clickup("POST", `/task/${taskId}/comment`, { comment_text: comment });
  return "✅ Comment posted!";
}
 
const SYSTEM_PROMPT = `You are a WhatsApp assistant for Bolted Iron. Your ONLY job is to post comments on ClickUp tasks.
 
How it works:
1. User tells you a job address (vaguely) and a comment to post
2. You search for matching tasks using search_tasks
3. If 1 match → post the comment using post_comment
4. If multiple matches → list them and ask the user which one
5. If no match → tell the user
 
When you need to take an action, reply with ONLY this on one line:
<ACTION>{"action":"ACTION_NAME","params":{...}}</ACTION>
Then add a short message on the next line.
 
Actions:
- search_tasks: params: {query: "address keywords"}
- post_comment: params: {task_id: "id", comment: "the comment text"}
 
Keep replies short and casual like WhatsApp. Never make up task IDs.`;
 
async function handleAction(action, params, userPhone) {
  if (action === "search_tasks") {
    const matches = await searchTasks(params.query);
    return { type: "search_result", matches };
  }
  if (action === "post_comment") {
    const result = await postComment(params.task_id, params.comment);
    return { type: "done", message: result };
  }
  return { type: "done", message: "Unknown action." };
}
 
async function askClaude(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = [];
  conversations[userPhone].push({ role: "user", content: userMessage });
  if (conversations[userPhone].length > MAX_HISTORY) {
    conversations[userPhone] = conversations[userPhone].slice(-MAX_HISTORY);
  }
 
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: conversations[userPhone],
  });
 
  const rawText = response.content.map((b) => b.text || "").join("");
  conversations[userPhone].push({ role: "assistant", content: rawText });
 
  const actionMatch = rawText.match(/<ACTION>([\s\S]*?)<\/ACTION>/);
  const visibleText = rawText.replace(/<ACTION>[\s\S]*?<\/ACTION>/g, "").trim();
 
  if (actionMatch) {
    let parsed;
    try { parsed = JSON.parse(actionMatch[1]); } catch { return visibleText || "Error parsing action."; }
 
    const result = await handleAction(parsed.action, parsed.params || {}, userPhone);
 
    if (result.type === "search_result") {
      const matches = result.matches;
      if (matches.length === 0) {
        const msg = "I couldn't find any task matching that address. Can you give me more details?";
        conversations[userPhone].push({ role: "user", content: `[SYSTEM: search returned 0 results]` });
        return msg;
      }
      if (matches.length === 1) {
        // Auto-post if only one match
        const m = matches[0];
        // Extract the comment from visibleText or ask Claude to post it
        const commentMatch = parsed.params?.comment;
        if (commentMatch) {
          await postComment(m.id, commentMatch);
          return `✅ Comment posted on "${m.name}"!`;
        } else {
          // Tell Claude there was 1 match and ask it to post
          const systemMsg = `[SYSTEM: Found 1 task: "${m.name}" (ID: ${m.id}) in ${m.list}. Now post the comment using post_comment.]`;
          conversations[userPhone].push({ role: "user", content: systemMsg });
          return await askClaude(userPhone, systemMsg);
        }
      }
      // Multiple matches — ask user
      const list = matches.map((m, i) => `${i + 1}. ${m.name} (${m.list})`).join("\n");
      const systemMsg = `[SYSTEM: Found ${matches.length} tasks:\n${matches.map(m => `"${m.name}" ID:${m.id} in ${m.list}`).join("\n")}\nAsk the user which one.]`;
      conversations[userPhone].push({ role: "user", content: systemMsg });
      return `Found ${matches.length} matching tasks:\n${list}\n\nWhich one should I post the comment on?`;
    }
 
    if (result.type === "done") {
      return result.message;
    }
  }
 
  return visibleText || "...";
}
 
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = req.body.Body?.trim();
  const fromNumber = req.body.From;
  if (!incomingMsg || !fromNumber) return res.type("text/xml").send(twiml.toString());
 
  console.log(`📨 ${fromNumber}: ${incomingMsg}`);
  try {
    const reply = await askClaude(fromNumber, incomingMsg);
    // Split long messages
    const MAX = 1500;
    if (reply.length > MAX) {
      const parts = reply.match(/.{1,1500}/gs) || [reply];
      for (const part of parts) twiml.message(part);
    } else {
      twiml.message(reply);
    }
    console.log(`🤖 Reply: ${reply}`);
  } catch (err) {
    console.error("Error:", err.message);
    twiml.message("⚠️ Something went wrong. Try again.");
  }
  res.type("text/xml").send(twiml.toString());
});
 
app.get("/", (req, res) => res.send("WhatsApp ClickUp Bot is running ✅"));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
