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
 
const LISTS = [
  { name: "Proposals", id: "901413446200", statuses: ["to do", "takeoffs/pricing", "changes needed", "proposal in progress", "jobs on hold", "complete"] },
  { name: "Josh Proposals", id: "901413557769", statuses: ["to do", "takeoffs/pricing", "changes needed", "proposals in progress", "jobs on hold", "sales to follow", "jobs approved", "job done", "rejected"] },
  { name: "Sales To Follow", id: "901413446202", statuses: [] },
  { name: "Job Status", id: "901413446203", statuses: ["additional proposal needed", "jobs confirmed", "deposit received", "job in progress", "to invoice", "collections", "done", "jobs not done", "complete"] },
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
          matches.push({ id: t.id, name: t.name, list: list.name, listId: list.id, status: t.status?.status });
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
 
async function updateStatus(taskId, status) {
  await clickup("PUT", `/task/${taskId}`, { status });
  return `✅ Status updated to "${status}"!`;
}
 
const SYSTEM_PROMPT = `You are a WhatsApp assistant for Bolted Iron. You do 2 things only:
1. Post comments on ClickUp tasks
2. Change the status of ClickUp tasks
 
Available lists and their statuses:
- Proposals: to do, takeoffs/pricing, changes needed, proposal in progress, jobs on hold, complete
- Josh Proposals: to do, takeoffs/pricing, changes needed, proposals in progress, jobs on hold, sales to follow, jobs approved, job done, rejected
- Job Status: additional proposal needed, jobs confirmed, deposit received, job in progress, to invoice, collections, done, jobs not done, complete
- Sales To Follow: (no status changes for this list)
 
How it works:
1. User mentions a job address and what they want to do (post comment or change status)
2. You search for matching tasks using search_tasks
3. If 1 match → do the action directly
4. If multiple matches → list them and ask which one
5. If no match → tell the user
 
When you need to take an action, reply with ONLY this on one line:
<ACTION>{"action":"ACTION_NAME","params":{...}}</ACTION>
Then add a short message on the next line.
 
Actions:
- search_tasks: params: {query: "address keywords"}
- post_comment: params: {task_id: "id", comment: "the comment text"}
- update_status: params: {task_id: "id", status: "exact status name lowercase"}
 
Rules:
- Always match status names exactly as listed above (lowercase)
- Never make up task IDs
- Keep replies short and casual like WhatsApp`;
 
async function handleAction(action, params) {
  if (action === "search_tasks") {
    const matches = await searchTasks(params.query);
    return { type: "search_result", matches };
  }
  if (action === "post_comment") {
    const result = await postComment(params.task_id, params.comment);
    return { type: "done", message: result };
  }
  if (action === "update_status") {
    const result = await updateStatus(params.task_id, params.status);
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
 
    const result = await handleAction(parsed.action, parsed.params || {});
 
    if (result.type === "search_result") {
      const matches = result.matches;
      if (matches.length === 0) {
        return "I couldn't find any task matching that address. Can you be more specific?";
      }
      if (matches.length === 1) {
        const m = matches[0];
        const systemMsg = `[SYSTEM: Found 1 task: "${m.name}" (ID: ${m.id}) in ${m.list}. Current status: ${m.status}. Now perform the requested action on it.]`;
        conversations[userPhone].push({ role: "user", content: systemMsg });
        return await askClaude(userPhone, systemMsg);
      }
      const list = matches.map((m, i) => `${i + 1}. ${m.name} (${m.list})`).join("\n");
      const systemMsg = `[SYSTEM: Found ${matches.length} tasks:\n${matches.map(m => `"${m.name}" ID:${m.id} in ${m.list} status:${m.status}`).join("\n")}\nAsk the user which one.]`;
      conversations[userPhone].push({ role: "user", content: systemMsg });
      return `Found ${matches.length} matching tasks:\n${list}\n\nWhich one?`;
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
