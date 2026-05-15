# WhatsApp ClickUp Bot 🤖

A WhatsApp AI assistant that manages your ClickUp workspace. Message it naturally — it understands plain English and takes action.

## What it can do

- List your workspaces, spaces, lists, and tasks
- Create tasks with priority, due date, and assignees
- Update or close tasks
- Search tasks by name

## Setup Guide

### 1. Install dependencies

```bash
npm install
```

### 2. Set environment variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

**ANTHROPIC_API_KEY** → https://console.anthropic.com  
**CLICKUP_API_TOKEN** → ClickUp → Profile picture → Apps → API Token

### 3. Deploy the server

You need a public URL for Twilio's webhook. Easiest options:

**Option A – Railway (recommended, free tier available)**
1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add your environment variables in Railway's Variables tab
4. Railway gives you a public URL like `https://your-bot.up.railway.app`

**Option B – Render**
1. Push to GitHub
2. Go to https://render.com → New Web Service → Connect repo
3. Build command: `npm install`  Start command: `npm start`
4. Add environment variables in Render's dashboard

**Option C – Local testing with ngrok**
```bash
npm install
npm start
# In another terminal:
npx ngrok http 3000
# Copy the https://xxxx.ngrok.io URL
```

### 4. Set up Twilio WhatsApp Sandbox

1. Sign up at https://www.twilio.com (free)
2. Go to **Messaging → Try it out → Send a WhatsApp message**
3. Follow the instructions to join the sandbox (you'll send a code to a Twilio number)
4. In the sandbox settings, set the **"When a message comes in"** webhook to:
   ```
   https://your-server-url/webhook
   ```
   Method: **HTTP POST**
5. Save

### 5. Start chatting!

Send a WhatsApp message to the Twilio sandbox number. Try:

- *"Show me my workspaces"*
- *"List tasks in list 123456"*
- *"Create a task called Fix login bug in list 123456 with high priority"*
- *"Close task abc123def"*
- *"Search for tasks about homepage"*

## How it works

```
You (WhatsApp) → Twilio → /webhook → Claude API → ClickUp API → reply back
```

Each user's conversation history is kept in memory (last 20 messages) so the bot remembers context within a session.

## Going to production

When you're ready to move off the Twilio sandbox to a real WhatsApp number:
1. Apply for a WhatsApp Business Account via Meta: https://business.facebook.com
2. Or use Twilio's WhatsApp-enabled numbers (requires Meta approval)
3. The code doesn't change — just update the Twilio number settings

## File structure

```
whatsapp-clickup-bot/
├── index.js        # Main server (webhook + Claude + ClickUp logic)
├── package.json
├── .env.example    # Copy to .env and fill in your keys
└── README.md
```
