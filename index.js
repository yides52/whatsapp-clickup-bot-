

import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import FormData from "form-data";
 
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
 
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
const conversations = {};
const MAX_HISTORY = 20;
 
const USERS = {
  "+19295915310": { name: "Yides", clickupToken: process.env.CLICKUP_API_TOKEN },
  "+19292751679": { name: "Moshe", clickupToken: "pk_50692553_9E8PZMBPLH1I0ZRDGQSTNHOGIGR8MLZC" },
};
 
function getUser(from) {
  const number = from.replace("whatsapp:", "");
  return USERS[number] || { name: "Unknown", clickupToken: process.env.CLICKUP_API_TOKEN };
}
 
function getUserName(from) {
  return getUser(from).name;
}
 
function getUserToken(from) {
  return getUser(from).clickupToken;
}
 
const LISTS = [
  { name: "Proposals", id: "901413446200", statuses: ["to do", "takeoffs/pricing", "changes needed", "proposal in progress", "jobs on hold", "complete"] },
  { name: "Josh Proposals", id: "901413557769", statuses: ["to do", "takeoffs/pricing", "changes needed", "proposals in progress", "jobs on hold", "sales to follow", "jobs approved", "job done", "rejected"] },
  { name: "Sales To Follow", id: "901413446202", statuses: [] },
  { name: "Job Status", id: "901413446203", statuses: ["additional proposal needed", "jobs confirmed", "deposit received", "job in progress", "to invoice", "collections", "done", "jobs not done", "complete"] },
];
 
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
      const data = await clickup("GET", `/list/${list.id}/task?page=${page}&include_closed=true`);
      if (!data.tasks?.length) break;
      for (const t of data.tasks) {
        allTasks.push({ id: t.id, name: t.name, list: list.name, listId: list.id, status: t.status?.status });
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
 
async function transcribeAudio(mediaUrl) {
  // Download audio from Twilio
  const audioRes = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });
 
  // Send to Groq Whisper
  const form = new FormData();
  form.append("file", Buffer.from(audioRes.data), { filename: "audio.ogg", contentType: "audio/ogg" });
  form.append("model", "whisper-large-v3");
  form.append("language", "en");
 
  const res = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
  });
 
  return res.data.text;
}
 
async function clickupAs(token, method, path, body = null) {
  const res = await axios({
    method,
    url: `https://api.clickup.com/api/v2${path}`,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    data: body || undefined,
  });
  return res.data;
}
 
async function postComment(taskId, comment, userToken) {
  await clickupAs(userToken, "POST", `/task/${taskId}/comment`, { comment_text: comment });
  return "✅ Comment posted!";
}
 
async function updateStatus(taskId, status, userToken) {
  await clickupAs(userToken, "PUT", `/task/${taskId}`, { status });
  const task = taskCache.find((t) => t.id === taskId);
  if (task) task.status = status;
  return `✅ Status updated to "${status}"!`;
}
 
async function moveToList(taskId, newListId, status, userToken) {
  await clickupAs(userToken, "POST", `/task/${taskId}/move/${newListId}`, {});
  if (status) {
    await clickupAs(userToken, "PUT", `/task/${taskId}`, { status });
  }
  const task = taskCache.find((t) => t.id === taskId);
  const newList = LISTS.find((l) => l.id === newListId);
  if (task) {
    task.listId = newListId;
    task.list = newList?.name || task.list;
    if (status) task.status = status;
  }
  return `✅ Moved to ${newList?.name || "new list"}${status ? ` and set to "${status}"` : ""}!`;
}
 
const SYSTEM_PROMPT = `You are Emily, the ClickUp assistant for Bolted Iron. You are Emily from Bolted Iron ClickUp. Talk like a helpful friend, not a robot. You know the user by name and use it naturally.
 
You do 2 things:
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
5. If no match → tell the user in a friendly way
6. ALWAYS confirm after every action in a natural, warm way
 
When you need to take an action, you can chain MULTIPLE actions in one reply by putting each on its own line:
<ACTION>{"action":"ACTION_NAME","params":{...}}</ACTION>
<ACTION>{"action":"ACTION_NAME","params":{...}}</ACTION>
 
All actions in a single message are executed in order. Add a short friendly summary at the end.
 
Actions:
- search_tasks: params: {query: "address keywords"}
- post_comment: params: {task_id: "id", comment: "the comment text (WITHOUT the user name, that is added automatically)"}
- update_status: params: {task_id: "id", status: "exact status name lowercase"}
- move_to_list: params: {task_id: "id", new_list_id: "list id", status: "status in new list or null"} — use this when user wants to move a task to a different list. If they already told you the status, include it. Only ask if they didn't mention it.
 
List IDs:
- Proposals: 901413446200
- Josh Proposals: 901413557769
- Sales To Follow: 901413446202
- Job Status: 901413446203
 
Example: if user says "move 575 flushing to job status, set to deposit received and post comment updated amount" you should:
1. search_tasks for "575 flushing"
2. Once found: move_to_list with status "deposit received" AND post_comment "updated amount" — all in one reply
 
Personality rules:
- Talk like a helpful friend, not a robot
- Use the person's name naturally (e.g. "On it Yides!" or "Got it Moshe!")
- Use casual language and occasional emojis 👍✅
- When searching say something like "On it! 🔍" or "Let me find that..."
- When done say something like "Done! Posted on 466 Lafayette 👍" or "Got it, status updated! ✅"
- If no match: "Hmm, can't find that one — can you give me a bit more of the address?"
- If multiple matches: "Found a few jobs matching that — which one did you mean?"
- For small talk (thanks, hi, how are you) — respond naturally and warmly
- Keep all replies short — this is WhatsApp not email
- DEFAULT action is post_comment unless user says "move", "change status", or "set status"
- Always match status names exactly as listed above (lowercase)
- Never make up task IDs`;
 
async function handleAction(action, params, userName, userToken) {
  if (action === "search_tasks") {
    const matches = searchCache(params.query);
    return { type: "search_result", matches };
  }
  if (action === "post_comment") {
    const result = await postComment(params.task_id, params.comment, userToken);
    return { type: "done", message: result };
  }
  if (action === "update_status") {
    const result = await updateStatus(params.task_id, params.status, userToken);
    return { type: "done", message: result };
  }
  if (action === "move_to_list") {
    const result = await moveToList(params.task_id, params.new_list_id, params.status || null, userToken);
    return { type: "done", message: result };
  }
  return { type: "done", message: "Unknown action." };
}
 
async function askClaude(userPhone, userMessage, userName, userToken) {
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
 
  // Extract all actions
  const actionMatches = [...rawText.matchAll(/<ACTION>([\s\S]*?)<\/ACTION>/g)];
  const visibleText = rawText.replace(/<ACTION>[\s\S]*?<\/ACTION>/g, "").trim();
 
  if (actionMatches.length > 0) {
    // Handle search first if present
    const searchAction = actionMatches.find(m => {
      try { return JSON.parse(m[1]).action === "search_tasks"; } catch { return false; }
    });
 
    if (searchAction) {
      let parsed;
      try { parsed = JSON.parse(searchAction[1]); } catch { return visibleText || "Error parsing action."; }
      const result = await handleAction(parsed.action, parsed.params || {}, userName, userToken);
 
      if (result.type === "search_result") {
        const matches = result.matches;
        if (matches.length === 0) {
          return `Hmm, can't find that one ${userName} — can you give me a bit more of the address? 🤔`;
        }
        if (matches.length === 1) {
          const m = matches[0];
          const systemMsg = `[SYSTEM: Found 1 task: "${m.name}" (ID: ${m.id}) in ${m.list}. Current status: ${m.status}. Now perform ALL the requested actions on it in order.]`;
          conversations[userPhone].push({ role: "user", content: systemMsg });
          return await askClaude(userPhone, systemMsg, userName, userToken);
        }
        const list = matches.map((m, i) => `${i + 1}. ${m.name} (${m.list})`).join("\n");
        const systemMsg = `[SYSTEM: Found ${matches.length} tasks:\n${matches.map(m => `"${m.name}" ID:${m.id} in ${m.list} status:${m.status}`).join("\n")}\nAsk the user which one, then perform all requested actions.]`;
        conversations[userPhone].push({ role: "user", content: systemMsg });
        return `Found a few jobs matching that — which one did you mean?\n\n${list}`;
      }
    } else {
      // Execute all non-search actions in order
      const results = [];
      for (const match of actionMatches) {
        let parsed;
        try { parsed = JSON.parse(match[1]); } catch { continue; }
        const result = await handleAction(parsed.action, parsed.params || {}, userName, userToken);
        if (result.type === "done") results.push(result.message);
      }
      if (results.length > 0) return results.join("\n");
    }
  }
 
  return visibleText || "...";
}
 
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const fromNumber = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0");
 
  if (!fromNumber) return res.type("text/xml").send(twiml.toString());
 
  const userName = getUserName(fromNumber);
  const userToken = getUserToken(fromNumber);
  let incomingMsg = req.body.Body?.trim();
 
  // Handle voice message
  if (numMedia > 0 && req.body.MediaContentType0?.includes("audio")) {
    try {
      const mediaUrl = req.body.MediaUrl0;
      console.log(`🎤 Voice message from ${userName}, transcribing...`);
      incomingMsg = await transcribeAudio(mediaUrl);
      console.log(`📝 Transcribed: ${incomingMsg}`);
    } catch (err) {
      console.error("Transcription error:", err.message);
      twiml.message("Sorry, I couldn't understand that voice note. Try typing it instead 😊");
      return res.type("text/xml").send(twiml.toString());
    }
  }
 
  if (!incomingMsg) return res.type("text/xml").send(twiml.toString());
 
  console.log(`📨 ${userName} (${fromNumber}): ${incomingMsg}`);
 
  try {
    const reply = await askClaude(fromNumber, incomingMsg, userName, userToken);
    const MAX = 1500;
    if (reply.length > MAX) {
      const parts = reply.match(/.{1,1500}/gs) || [reply];
      for (const part of parts) twiml.message(part);
    } else {
      twiml.message(reply);
    }
    console.log(`🤖 Emily to ${userName}: ${reply}`);
  } catch (err) {
    console.error("Error:", err.message);
    twiml.message("⚠️ Something went wrong. Try again.");
  }
  res.type("text/xml").send(twiml.toString());
});
 
app.get("/", (req, res) => {
  const age = cacheLastUpdated ? Math.round((Date.now() - cacheLastUpdated) / 60000) + " mins ago" : "not yet";
  res.send(`Emily (Bolted Iron ClickUp Bot) ✅ | Cache: ${taskCache.length} tasks | Last updated: ${age}`);
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Emily is running on port ${PORT}`);
  await startCacheRefresh();
});
