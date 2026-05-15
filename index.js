import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory conversation history per user (keyed by WhatsApp number)
const conversations = {};
const MAX_HISTORY = 20; // keep last 20 messages per user

// ─── ClickUp helpers ──────────────────────────────────────────────────────────

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

async function executeClickUpAction(action, params) {
  switch (action) {
    case "get_teams": {
      const data = await clickup("GET", "/team");
      if (!data.teams?.length) return "You have no workspaces.";
      return (
        "Your workspaces:\n" +
        data.teams.map((t) => `• ${t.name} (ID: ${t.id})`).join("\n")
      );
    }

    case "get_spaces": {
      const data = await clickup("GET", `/team/${params.team_id}/space`);
      if (!data.spaces?.length) return "No spaces found.";
      return (
        "Spaces:\n" +
        data.spaces.map((s) => `• ${s.name} (ID: ${s.id})`).join("\n")
      );
    }

    case "get_lists": {
      const data = await clickup("GET", `/space/${params.space_id}/list`);
      if (!data.lists?.length) return "No lists found.";
      return (
        "Lists:\n" +
        data.lists.map((l) => `• ${l.name} (ID: ${l.id})`).join("\n")
      );
    }

    case "get_tasks": {
      const data = await clickup(
        "GET",
        `/list/${params.list_id}/task?page=${params.page || 0}`
      );
      if (!data.tasks?.length) return "No tasks in that list.";
      return (
        `Tasks (${data.tasks.length}):\n` +
        data.tasks
          .map((t) => `• [${t.status?.status || "?"}] ${t.name} — ID: ${t.id}`)
          .join("\n")
      );
    }

    case "create_task": {
      const data = await clickup("POST", `/list/${params.list_id}/task`, {
        name: params.name,
        description: params.description,
        priority: params.priority,
        due_date: params.due_date,
        assignees: params.assignees,
      });
      return `✅ Task created: "${data.name}"\nID: ${data.id}`;
    }

    case "update_task": {
      const { task_id, ...body } = params;
      const data = await clickup("PUT", `/task/${task_id}`, body);
      return `✅ Updated: "${data.name}"`;
    }

    case "close_task": {
      const data = await clickup("PUT", `/task/${params.task_id}`, {
        status: "closed",
      });
      return `✅ Closed: "${data.name}"`;
    }

    case "search_tasks": {
      const data = await clickup(
        "GET",
        `/team/${params.team_id}/task?query=${encodeURIComponent(params.query)}`
      );
      if (!data.tasks?.length) return `No tasks found matching "${params.query}".`;
      return (
        `Found ${data.tasks.length} task(s):\n` +
        data.tasks
          .map((t) => `• ${t.name} (${t.status?.status}) — ID: ${t.id}`)
          .join("\n")
      );
    }

    default:
      return `I don't know how to do "${action}" yet.`;
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a friendly WhatsApp assistant that helps users manage their ClickUp workspace.
Speak casually and concisely — like a helpful colleague on WhatsApp.

When the user wants a ClickUp action, respond with ONLY this format (nothing else on that line):
<CLICKUP_ACTION>{"action":"ACTION_NAME","params":{...}}</CLICKUP_ACTION>

Then on the next line, add a short friendly message about what you did.

Supported actions:
- get_teams — list all workspaces (no params)
- get_spaces — params: {team_id}
- get_lists — params: {space_id}
- get_tasks — params: {list_id, page?}
- create_task — params: {list_id, name, description?, priority?(1-4), due_date?(ms), assignees?([ids])}
- update_task — params: {task_id, name?, description?, status?, priority?, due_date?}
- close_task — params: {task_id}
- search_tasks — params: {team_id, query}

Priority levels: 1=urgent, 2=high, 3=normal, 4=low
Keep all replies short (WhatsApp style). No markdown headers. No bullet walls.`;

// ─── Claude handler ───────────────────────────────────────────────────────────

async function askClaude(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = [];

  conversations[userPhone].push({ role: "user", content: userMessage });

  // Trim history
  if (conversations[userPhone].length > MAX_HISTORY) {
    conversations[userPhone] = conversations[userPhone].slice(-MAX_HISTORY);
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: conversations[userPhone],
  });

  const rawText = response.content.map((b) => b.text || "").join("");
  conversations[userPhone].push({ role: "assistant", content: rawText });

  // Check for ClickUp action
  const actionMatch = rawText.match(/<CLICKUP_ACTION>([\s\S]*?)<\/CLICKUP_ACTION>/);
  const visibleText = rawText
    .replace(/<CLICKUP_ACTION>[\s\S]*?<\/CLICKUP_ACTION>/g, "")
    .trim();

  if (actionMatch) {
    let parsed;
    try {
      parsed = JSON.parse(actionMatch[1]);
    } catch {
      return visibleText || "I had trouble understanding that action.";
    }

    const actionResult = await executeClickUpAction(
      parsed.action,
      parsed.params || {}
    );

    const finalReply = [visibleText, actionResult].filter(Boolean).join("\n\n");
    return finalReply;
  }

  return visibleText || "...";
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const incomingMsg = req.body.Body?.trim();
  const fromNumber = req.body.From; // e.g. "whatsapp:+1234567890"

  if (!incomingMsg || !fromNumber) {
    return res.type("text/xml").send(twiml.toString());
  }

  console.log(`📨 ${fromNumber}: ${incomingMsg}`);

  try {
    const reply = await askClaude(fromNumber, incomingMsg);
    console.log(`🤖 Reply: ${reply}`);
    twiml.message(reply);
  } catch (err) {
    console.error("Error:", err.message);
    twiml.message(
      "⚠️ Sorry, something went wrong. Try again in a moment."
    );
  }

  res.type("text/xml").send(twiml.toString());
});

// Health check
app.get("/", (req, res) => res.send("WhatsApp ClickUp Bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
