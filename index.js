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
 
// ─── Twilio client for sending reactions ────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
 
function getUser(from) {
  // Strip whatsapp: prefix and group participant suffix (e.g. whatsapp:+19295915310_groupid)
  const number = from.replace("whatsapp:", "").split("_")[0];
  return USERS[number] || { name: "Unknown", clickupToken: process.env.CLICKUP_API_TOKEN };
}
 
function getUserName(from) {
  return getUser(from).name;
}
 
function getUserToken(from, isGroup = false) {
  // Group messages → post under Emily's ClickUp profile
  // Private DMs → post under the sender's own ClickUp profile
  if (isGroup) return process.env.CLICKUP_EMILY_TOKEN;
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
  const audioRes = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });
 
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
 
async function postComment(taskId, comment, userToken, senderName = null) {
  const commentText = senderName ? `${senderName}: ${comment}` : comment;
  await clickupAs(userToken, "POST", `/task/${taskId}/comment`, { comment_text: commentText });
  return "✅ Comment posted!";
}
 
async function updateStatus(taskId, status, userToken) {
  await clickupAs(userToken, "PUT", `/task/${taskId}`, { status });
  const task = taskCache.find((t) => t.id === taskId);
  if (task) task.status = status;
  return `✅ Status updated to "${status}"!`;
}
 
async function createTask(listId, name, status, comment, userToken) {
  const body = { name };
  if (status) body.status = status;
  const data = await clickupAs(userToken, "POST", `/list/${listId}/task`, body);
  if (comment) {
    await clickupAs(userToken, "POST", `/task/${data.id}/comment`, { comment_text: comment });
  }
  const list = LISTS.find((l) => l.id === listId);
  taskCache.push({ id: data.id, name: data.name, list: list?.name || "Unknown", listId, status: status || "to do" });
  return `✅ Task "${name}" created${status ? ` with status "${status}"` : ""}${comment ? " and comment posted" : ""}!`;
}
 
async function moveToList(taskId, newListId, status, userToken) {
  await clickupAs(userToken, "DELETE", `/list/${newListId}/task/${taskId}`, null).catch(() => {});
  await clickupAs(userToken, "POST", `/list/${newListId}/task/${taskId}`, {});
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
 
// ─── React to a WhatsApp message with an emoji ───────────────────────────────
// messageSid = the SID of the message to react to
// toNumber   = the group/chat WA number Emily is replying in (req.body.To)
async function reactToMessage(messageSid, toNumber, emoji = "✅") {
  try {
    // Twilio reactions endpoint (WhatsApp Business API via Twilio)
    // This sends an in-chat emoji reaction to a specific message SID
    await twilioClient.messages.create({
      from: toNumber,                       // Emily's Twilio WA number
      to: toNumber,                         // same group/chat
      body: "",                             // required field — empty for reaction
      contentSid: undefined,
      // Reaction payload via Twilio's WhatsApp reaction support
      persistentAction: [`react:${messageSid}:${emoji}`],
    });
    console.log(`👍 Reacted ${emoji} to message ${messageSid}`);
  } catch (err) {
    // Reactions may not be supported in sandbox — log but don't crash
    console.warn("⚠️ Could not send reaction (may need WA Business API):", err.message);
  }
}
 
// ─── Detect if Emily was tagged in a group message ──────────────────────────
// Returns true if the message body contains @Emily (case-insensitive)
function isTaggedEmily(body = "") {
  return /\@emily/i.test(body);
}
 
// ─── Extract the actual instruction from a tagged group message ──────────────
// Strips the @Emily mention so Claude only sees the real instruction
function extractInstruction(body = "") {
  return body.replace(/@emily/gi, "").trim();
}
 
const SYSTEM_PROMPT = `You are Emily, the ClickUp assistant for Bolted Iron. You are Emily from Bolted Iron ClickUp. Talk like a helpful friend, not a robot. You know the user by name and use it naturally.
 
You do these things:
1. Post comments on ClickUp tasks (DEFAULT action)
2. Change the status of ClickUp tasks
3. Create new tasks in any list
4. Handle multiple actions at once
 
IMPORTANT: You CAN create new tasks. Never tell the user you cannot create tasks. Always use the create_task action when asked.
 
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
- create_task: params: {list_id: "id", name: "task name", status: "status or null", comment: "comment text or null"} — use when user wants to create a new task. If user doesn't specify which list, ask them. If user doesn't specify a status, ask them before creating. If the status they mention exists in multiple lists, ask which list. If they specify a comment, post it after creating.
 
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
- Never make up task IDs
 
GROUP CHAT RULES:
- When someone tags you in a group, the quoted/replied message is their instruction
- Keep responses brief since the whole group can see them
- Always address the person who tagged you by name`;
 
async function handleAction(action, params, userName, userToken, isGroup = false) {
  if (action === "search_tasks") {
    const matches = searchCache(params.query);
    return { type: "search_result", matches };
  }
  if (action === "post_comment") {
    const result = await postComment(params.task_id, params.comment, userToken, isGroup ? userName : null);
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
  if (action === "create_task") {
    const result = await createTask(params.list_id, params.name, params.status || null, params.comment || null, userToken);
    return { type: "done", message: result };
  }
  return { type: "done", message: "Unknown action." };
}
 
async function askClaude(userPhone, userMessage, userName, userToken, isGroup = false) {
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
 
  const actionMatches = [...rawText.matchAll(/<ACTION>([\s\S]*?)<\/ACTION>/g)];
  const visibleText = rawText.replace(/<ACTION>[\s\S]*?<\/ACTION>/g, "").trim();
 
  if (actionMatches.length > 0) {
    const searchAction = actionMatches.find(m => {
      try { return JSON.parse(m[1]).action === "search_tasks"; } catch { return false; }
    });
 
    if (searchAction) {
      let parsed;
      try { parsed = JSON.parse(searchAction[1]); } catch { return visibleText || "Error parsing action."; }
      const result = await handleAction(parsed.action, parsed.params || {}, userName, userToken, isGroup);
 
      if (result.type === "search_result") {
        const matches = result.matches;
        if (matches.length === 0) {
          return { text: `Hmm, can't find that one ${userName} — can you give me a bit more of the address? 🤔`, done: false };
        }
        if (matches.length === 1) {
          const m = matches[0];
          const systemMsg = `[SYSTEM: Found 1 task: "${m.name}" (ID: ${m.id}) in ${m.list}. Current status: ${m.status}. Now perform ALL the requested actions on it in order.]`;
          conversations[userPhone].push({ role: "user", content: systemMsg });
          return await askClaude(userPhone, systemMsg, userName, userToken, isGroup);
        }
        const list = matches.map((m, i) => `${i + 1}. ${m.name} (${m.list})`).join("\n");
        const systemMsg = `[SYSTEM: Found ${matches.length} tasks:\n${matches.map(m => `"${m.name}" ID:${m.id} in ${m.list} status:${m.status}`).join("\n")}\nAsk the user which one, then perform all requested actions.]`;
        conversations[userPhone].push({ role: "user", content: systemMsg });
        return { text: `Found a few jobs matching that — which one did you mean?\n\n${list}`, done: false };
      }
    } else {
      // Execute all non-search actions — these are real ClickUp changes → done = true
      const results = [];
      for (const match of actionMatches) {
        let parsed;
        try { parsed = JSON.parse(match[1]); } catch { continue; }
        const result = await handleAction(parsed.action, parsed.params || {}, userName, userToken, isGroup);
        if (result.type === "done") results.push(result.message);
      }
      if (results.length > 0) return { text: results.join("\n"), done: true };
    }
  }
 
  return { text: visibleText || "...", done: false };
}
 
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const fromNumber = req.body.From;   // who sent the message
  const toNumber = req.body.To;       // Emily's Twilio WA number (or group)
  const numMedia = parseInt(req.body.NumMedia || "0");
  const isGroup = req.body.To?.includes("whatsapp:") && req.body.GroupId;
  const originalMessageSid = req.body.MessageSid; // SID of incoming message to react to
 
  if (!fromNumber) return res.type("text/xml").send(twiml.toString());
 
  // ─── GROUP CHAT: only respond when tagged @Emily ──────────────────────────
  if (isGroup) {
    const rawBody = req.body.Body?.trim() || "";
    if (!isTaggedEmily(rawBody)) {
      // Not tagged — silently ignore
      return res.type("text/xml").send(twiml.toString());
    }
  }
 
  const userName = getUserName(fromNumber);
  const userToken = getUserToken(fromNumber, isGroup);
 
  // ─── Build instruction: use quoted/replied message if available ───────────
  // Twilio passes the replied-to message body in OriginalRepliedMessageBody
  let incomingMsg;
  const quotedMessage = req.body.OriginalRepliedMessageBody?.trim();
  const tagBody = req.body.Body?.trim() || "";
 
  if (isGroup && quotedMessage) {
    // They replied to a message and tagged Emily — use the quoted message as instruction
    // Strip any @Emily from the tag message and combine if there's extra instruction
    const tagInstruction = extractInstruction(tagBody);
    incomingMsg = tagInstruction
      ? `${quotedMessage} — ${tagInstruction}`  // e.g. "466 Lafayette client called — post comment"
      : quotedMessage;
  } else if (isGroup) {
    // Tagged in group but no quote — use the tag message itself (minus @Emily)
    incomingMsg = extractInstruction(tagBody);
  } else {
    // ─── Direct/private message — original flow ───────────────────────────
    incomingMsg = tagBody;
  }
 
  // Handle voice note
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
 
  console.log(`📨 ${userName} (${fromNumber})${isGroup ? " [GROUP]" : ""}: ${incomingMsg}`);
 
  try {
    // Use fromNumber as conversation key for DMs, group ID for groups
    const convKey = isGroup ? req.body.GroupId : fromNumber;
    const result = await askClaude(convKey, incomingMsg, userName, userToken, isGroup);
    const reply = typeof result === "string" ? result : result.text;
    const actionDone = typeof result === "object" ? result.done : false;
 
    const MAX = 1500;
    if (reply.length > MAX) {
      const parts = reply.match(/.{1,1500}/gs) || [reply];
      for (const part of parts) twiml.message(part);
    } else {
      twiml.message(reply);
    }
 
    console.log(`🤖 Emily to ${userName}: ${reply}`);
 
    // ─── React ✅ to the original message when a real action was completed ──
    if (actionDone && isGroup && originalMessageSid) {
      // Send reaction after we've already responded (non-blocking)
      reactToMessage(originalMessageSid, toNumber, "✅").catch(console.warn);
    }
 
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
 
