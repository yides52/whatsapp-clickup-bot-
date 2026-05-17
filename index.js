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
 
// ─── Users ────────────────────────────────────────────────────────────────────
const USERS = {
  "+19295915310": "Yides",
  "+19292751679": "Moshe",
};
 
function getUserName(from) {
  // from is like "whatsapp:+19295915310"
  const number = from.replace("whatsapp:", "");
  return USERS[number] || "Unknown";
}
 
const LISTS = [
  { name: "Proposals", id: "901413446200", statuses: ["to do", "takeoffs/pricing", "changes needed", "proposal in progress", "jobs on hold", "complete"] },
  { name: "Josh Proposals", id: "901413557769", statuses: ["to do", "takeoffs/pricing", "changes needed", "proposals in progress", "jobs on hold", "sales to follow", "jobs approved", "job done", "rejected"] },
  { name: "Sales To Follow", id: "901413446202", statuses: [] },
  { name: "Job Status", id: "901413446203", statuses: ["additional proposal needed", "jobs confirmed", "deposit received", "job in progress", "to invoice", "collections", "done", "jobs not done", "complete"] },
];
 
// ─── Task Cache ───────────────────────────────────────────────────────────────
let taskCache = [];
let cacheLastUpdated = null;
 
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
 
async function buildCache() {
  console.log("🔄 Building task cache...");
  const allTasks = [];
  for (const list of LISTS) {
    let page = 0;
    while (true) {
      const data = await clickup("GET", `/list/${list.id}/task?page=${page}`);
      if (!data.tasks?.length) break;
      for (const t of data.tasks) {
        allTasks.push({
          id: t.id,
          name: t.name,
          list: list.name,
          listId: list.id,
          status: t.status?.status,
        });
      }
      if (!data.last_page) page++;
      else break;
    }
  }
  taskCache = allTasks;
  cacheLastUpdated = new Date();
  console.log(`✅ Cache built: ${taskCache.length} tasks loaded.`);
}
 
async function startCacheRefresh() {
  await buildCache();
  setInterval(buildCache, 60 * 60 * 1000);
}
 
function searchCache(query) {
  const q = query.toLowerCase();
  return taskCache.filter((t) => t.name.toLowerCase().includes(q));
}
 
// ─── ClickUp actions ──────────────────────────────────────────────────────────
async function postComment(taskId, comment, userName) {
  await clickup("POST", `/task/${taskId}/comment`, { comment_text: `${userName}: ${comment}` });
  return "✅ Comment posted!";
}
 
async function updateStatus(taskId, status, userName) {
  await clickup("PUT", `/task/${taskId}`, { status });
  await clickup("POST", `/task/${taskId}/comment`, { comment_text: `${userName} changed status to: ${status}` });
  const task = taskCache.find((t) => t.id === taskId);
  if (task) task.status = status;
  return `✅ Status updated to "${status}"!`;
}
 
// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a WhatsApp assistant for Bolted Iron. You do 2 things only:
1. Post comments on ClickUp tasks (DEFAULT action)
2. Change the status of ClickUp tasks
 
Available lists and their statuses:
- Proposals: to do, takeoffs/pricing, changes needed, proposal in progress, jobs on hold, complete
- Josh Proposals: to do, takeoffs/pricing, changes needed, proposals in progress, jobs on hold, sales to follow, jobs approved, job done, rejected
- Job Status: additional proposal needed, jobs confirmed, deposit received, job in progress, to invoice, collections, done, jobs not done, complete
- Sales To Follow: (no status changes for this list)
 
How it works:
1. User mentions a job address — DEFAULT is to post a comment unless they say "move to" or "change status"
2. You search for matching tasks using search_tasks
3. If 1 match → do the action directly
4. If multiple matches → list them and ask which one
5. If no match → tell the user
6. ALWAYS send a confirmation message after every action
 
When you need to take an action, reply with ONLY this on one line:
<ACTION>{"action":"ACTION_NAME","params":{...}}</ACTION>
Then add a short message on the next line.
 
Actions:
- search_tasks: params: {query: "address keywords"}
- post_comment: params: {task_id: "id", comment: "the comment text (WITHOUT the user's name, that is added automatically)"}
- update_status: params: {task_id: "id", status: "exact status name lowercase"}
 
Rules:
- DEFAULT action is post_comment unless user says "move", "change status", or "set status"
- If user just says an address + text with no action word → post it as a comment
- Always match status names exactly as listed above (lowercase)
- Never make up task IDs
- Keep replies short and casual like WhatsApp
- ALWAYS reply with a confirmation after every action`;
 
async function handleAction(action, params, userName) {
  if (action === "search_tasks") {
    const matches = searchCache(params.query);
    return { type: "search_result", matches };
  }
  if (action === "post_comment") {
    const result = await postComment(params.task_id, params.comment, userName);
    return { type: "done", message: result };
  }
  if (action === "update_status") {
    const result = await updateStatus(params.task_id, params.status, userName);
    return { type: "done", message: result };
  }
  return { type: "done", message: "Unknown action." };
}
 
async function askClaude(userPhone, userMessage, userName) {
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
 
    const result = await handleAction(parsed.action, parsed.params || {}, userName);
 
    if (result.type === "search_result") {
      const matches = result.matches;
      if (matches.length === 0) {
        return "I couldn't find any task matching that address. Can you be more specific?";
      }
      if (matches.length === 1) {
        const m = matches[0];
        const systemMsg = `[SYSTEM: Found 1 task: "${m.name}" (ID: ${m.id}) in ${m.list}. Current status: ${m.status}. Now perform the requested action on it.]`;
        conversations[userPhone].push({ role: "user", content: systemMsg });
        return await askClaude(userPhone, systemMsg, userName);
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
 
// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = req.body.Body?.trim();
  const fromNumber = req.body.From;
  if (!incomingMsg || !fromNumber) return res.type("text/xml").send(twiml.toString());
 
  const userName = getUserName(fromNumber);
  console.log(`📨 ${userName} (${fromNumber}): ${incomingMsg}`);
 
  try {
    const reply = await askClaude(fromNumber, incomingMsg, userName);
    const MAX = 1500;
    if (reply.length > MAX) {
      const parts = reply.match(/.{1,1500}/gs) || [reply];
      for (const part of parts) twiml.message(part);
    } else {
      twiml.message(reply);
    }
    console.log(`🤖 Reply to ${userName}: ${reply}`);
  } catch (err) {
    console.error("Error:", err.message);
    twiml.message("⚠️ Something went wrong. Try again.");
  }
  res.type("text/xml").send(twiml.toString());
});
 
app.get("/", (req, res) => {
  const age = cacheLastUpdated ? Math.round((Date.now() - cacheLastUpdated) / 60000) + " mins ago" : "not yet";
  res.send(`WhatsApp ClickUp Bot ✅ | Cache: ${taskCache.length} tasks | Last updated: ${age}`);
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await startCacheRefresh();
});
 
