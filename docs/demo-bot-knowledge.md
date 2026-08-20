# Demo bot — paste-ready knowledge base

The landing page at `public/index.html` carries a live widget. It currently
points at the Pearl Dental demo bot, which works but talks about dentistry on a
page about ConverseKit.

This file exists so replacing it is copy-paste rather than a writing task.

## Setup

1. Create a bot in the dashboard. Name it **ConverseKit**.
2. **Allowed origins** — this is the step that silently breaks everything if
   missed. The bot must allow the page's origin exactly:

   ```
   https://conversekit-widget.pages.dev
   ```

   No trailing slash and no path — the API compares origins exactly, scheme and
   port included, and rejects anything else with a 403.
3. Set **primary color** to `#EEBA2B` so the widget matches the page.
4. Paste the sections below into their homes. Since
   [011](../supabase/011_knowledge.sql) those are three different places, and
   the split is the point — see [knowledge.md](knowledge.md):
   - **Business description**, **hours** and **contact** → Bot Configuration.
     Small, and always in the prompt, so the bot knows them whatever it is asked.
   - **Custom instructions** → Bot Configuration → Instructions.
   - **FAQ** → Knowledge → FAQ, one item per `Q:` / `A:` pair below. Each is
     indexed on its own.
   - **Services / features** → Knowledge → Sources, as a `text` source. It is
     prose, and prose is what the ordinary chunker is for.
5. Copy the new bot's id into `public/index.html` — the single `data-bot-id`
   on the last script tag, which is commented as the line to change.
6. Redeploy: `npm run deploy:pages`.

Optionally add this file itself as a **source** (type: text) under Knowledge →
Sources, which gives the bot retrieval over its own documentation.

---

## Business description

ConverseKit is a multi-tenant conversational AI platform. It gives any website a
chat widget that answers visitor questions from that business's own knowledge
base, and captures leads during the conversation.

It installs with a single `<script>` tag and needs no build step on the client's
side. One Cloudflare Worker serves the API and one Cloudflare Pages site serves
the widget and the admin dashboard, together supporting an unlimited number of
client bots. Each bot is a row in Postgres with its own branding, knowledge,
allowed origins and AI provider settings.

It is built on Cloudflare Workers with Hono, Supabase Postgres with pgvector for
retrieval, and a pluggable provider layer that speaks to eleven AI vendors
through one interface.

## Services / features

- **Drop-in chat widget** — one script tag, self-styling from the bot's brand
  colour, mobile-friendly, keyboard accessible.
- **Answers from your documents** — paste text or markdown, or point it at a
  URL. Longer material is chunked, embedded and searched at question time, and
  the answer cites what it used.
- **Lead capture** — the assistant collects a name, email or phone number when a
  visitor shows intent, and files it as a lead you can export to CSV.
- **Eleven AI vendors, one interface** — OpenAI, Anthropic Claude, Google
  Gemini, Groq, OpenRouter, Mistral, Cloudflare Workers AI, DeepSeek, Together
  AI, Ollama, LM Studio, plus any OpenAI-compatible endpoint. Switching is a
  dropdown, per bot.
- **Bring your own key** — each bot can carry its own vendor credentials, stored
  write-only and redacted from every API response.
- **Streaming replies** — token-by-token over SSE, with an automatic fallback to
  a buffered endpoint if the stream fails.
- **Multi-tenant isolation** — row-level security in Postgres keyed off
  organization membership, so two organizations cannot see each other's bots,
  leads or conversations.
- **Origin lock** — each bot carries a list of allowed origins; requests from
  anywhere else are refused before the model is called.
- **Admin dashboard** — playground, bot settings, knowledge base, knowledge
  sources with a chunk inspector, retrieval tuning, provider selection, leads
  and conversation transcripts.

## Hours / availability

The API runs on Cloudflare's edge network and is available continuously. There
are no support hours; this is a self-serve product.

## Contact

Use the dashboard to manage bots. For anything else, reach the maintainer
through the project repository.

## FAQ

**How do I install it?**
Create a bot in the dashboard, fill in what it should know, then paste the
script tag with your bot id before the closing `</body>` tag of your site.

**Do I need to change my site's build setup?**
No. It is one script tag. There is nothing to install, bundle or compile.

**What does it cost to run?**
It can run at no cost. Gemini Flash Lite for chat and Cloudflare Workers AI
for embeddings handle the whole loop — ingest, retrieve, answer — on free
tiers, and that is the platform default.

**Which AI models can I use?**
Eleven vendors are built in, plus any OpenAI-compatible endpoint including local
servers like Ollama and LM Studio. Each bot picks its own vendor and model.

**Can I use my own API key?**
Yes. Each bot can carry its own vendor credentials. Keys are write-only through
the API — once stored they are never returned, and the dashboard shows only the
last few characters.

**Why isn't my widget answering?**
Almost always the origin. The bot's allowed origins must match the site's origin
exactly, including scheme and port, with no trailing slash or path. The second
common cause is an empty knowledge base — the bot needs something to say.

**How does it know about my business?**
You provide it. Fill in the knowledge base fields, or add knowledge sources for
anything longer. At question time the query is embedded and matched against your
content by similarity, and the best passages are put into the prompt.

**What happens if retrieval fails?**
The turn still gets answered. A bot with no corpus, or an embedding vendor
having a bad minute, falls back to the plain knowledge-base prompt rather than
failing the visitor's question.

**Is my data separate from other customers'?**
Yes. Isolation is enforced by row-level security policies in Postgres rather
than by application code, and there is a test that authenticates as one
organization and tries to read another's records directly.

**Can I see what the bot is actually retrieving?**
Yes. The dashboard shows the chunks each document produced, and lets you
reindex a source after editing it.

**Can I open the chat from my own button?**
Yes. Once the widget has loaded it exposes `window.ConverseKit` with `open()`,
`close()`, `toggle()` and `isOpen()`.

## Custom instructions

You are the assistant for ConverseKit itself. Visitors are usually developers or
agency owners evaluating whether to use it.

Be direct and concrete. Prefer specifics over marketing language — name the
actual vendors, the actual limits, the actual failure modes. If someone asks
whether it does something that is not in your knowledge base, say you do not
know rather than guessing; this product's own pitch is that it admits ignorance
instead of inventing answers, so doing otherwise would be a poor demonstration.

Keep replies short. Two or three sentences is usually right; use a short list
only when the answer genuinely is a list.
