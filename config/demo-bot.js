// ----------------------------------------------------------------
// The demo bot — the one on our own landing page.
//
// This is the ONLY declaration of what that bot is. Its ids, its
// settings and its corpus all live here, because all three have to
// agree across three places that never see each other:
//
//   config/origins.js          exports DEMO_BOT_ID as the
//                              `__CK_DEMO_BOT__` build token
//   apps/site/assets/index.html carries that token on the widget tag
//   scripts/seed-demo-bot.mjs  provisions the rows this describes
//
// WHY A FIXED UUID RATHER THAN "whatever the dashboard generated".
// The bot id is baked into the landing page at build time, so a
// generated one means the page can only be built after the database
// has been seeded, and has to be rebuilt after every reseed. A fixed
// id makes seeding and building independent: either can run first, and
// `npm run db:reset` does not invalidate a deployed page.
//
// WHY THE CORPUS IS HERE AND NOT IN THE DASHBOARD. It was in the
// dashboard, in the sense that docs/demo-bot-knowledge.md told a human
// to paste it in by hand. That is exactly why the landing page has been
// shipping a widget pointed at a bot that does not exist: a schema
// reset erased the rows and there was nothing to replay them from.
//
// Editing the text below and re-running `npm run seed:demo` is the
// supported way to change what the demo bot knows. The seed replaces
// the corpus wholesale, so removing an FAQ here removes it there.
// ----------------------------------------------------------------

/**
 * Fixed identifiers. Version nibble 4 and variant nibble 8, so they are
 * well-formed v4 UUIDs; `d3f0` reads as "demo" at a glance, which is
 * the point — these should never be mistaken for tenant data.
 *
 * The org is separate from whatever org the owner's own signup
 * provisioned. It has to be: supabase/002 carries a unique index of one
 * bot per organization, so the demo bot cannot share an org with a
 * personal one.
 */
export const DEMO_ORG_ID = 'd3f00000-0000-4000-8000-000000000001';
export const DEMO_BOT_ID = 'd3f00000-0000-4000-8000-000000000002';

/** Shown in the dashboard org switcher, and nowhere a visitor sees. */
export const DEMO_ORG_NAME = 'ConverseKit';

/**
 * The bot row. Column names, not camelCase — this object is written
 * to PostgREST as-is, so a typo here is a column that silently does
 * not exist rather than a field that silently does nothing.
 *
 * `allowed_origins` is filled in by the seed from config/origins.js
 * rather than written here: it is a hostname, and hostnames have one
 * home in this repo.
 */
export const DEMO_BOT = {
  name: 'ConverseKit',
  business_name: 'ConverseKit',

  // Matches the landing page's own accent, so the launcher does not
  // read as a third-party widget bolted onto someone else's site.
  primary_color: '#EEBA2B',

  // Always in the prompt, so the bot knows these whatever it is asked
  // and whatever retrieval returns. Capped at 600 characters by
  // src/config.ts; this is comfortably inside that.
  business_description:
    'ConverseKit is a multi-tenant conversational AI platform. It gives any website a ' +
    'chat widget that answers visitor questions from that business’s own knowledge base, ' +
    'and captures leads during the conversation. It installs with one script tag and needs ' +
    'no build step on the client’s side. Four Cloudflare Workers serve the API, the widget, ' +
    'the dashboard and this site, together supporting an unlimited number of client bots. ' +
    'Each bot is a row in Postgres with its own branding, knowledge, allowed origins and AI ' +
    'provider settings.',

  // Standing rules rather than knowledge. The instruction to admit
  // ignorance is load-bearing on a page whose pitch is that the product
  // does exactly that: a demo bot that bluffs is an argument against
  // buying it.
  custom_instructions:
    'You are the assistant for ConverseKit itself. Visitors are usually developers or agency ' +
    'owners evaluating whether to use it.\n\n' +
    'Be direct and concrete. Prefer specifics over marketing language — name the actual ' +
    'vendors, the actual limits, the actual failure modes. If someone asks whether it does ' +
    'something that is not in your knowledge base, say you do not know rather than guessing; ' +
    'this product’s own pitch is that it admits ignorance instead of inventing answers, so ' +
    'doing otherwise would be a poor demonstration.\n\n' +
    'Keep replies short. Two or three sentences is usually right; use a short list only when ' +
    'the answer genuinely is a list.',

  // The chips a visitor sees before typing anything. Four, because the
  // panel is 380px wide and a fifth wraps to a second row that pushes
  // the composer down. These are the questions an evaluator actually
  // opens with.
  suggestions: [
    'How do I install it?',
    'Which AI models can I use?',
    'What does it cost to run?',
    'Is my data separate from other customers’?',
  ],

  // The structured business card the widget renders as real affordances
  // rather than as a URL the model retypes. Sparse on purpose: this is
  // a self-serve product with no premises and no opening hours, and
  // inventing either to fill the shape out would be a lie the widget
  // then displays.
  profile: {
    identity: {
      legal_name: 'ConverseKit',
      tagline: 'Drop-in AI chat for any website',
      industry: 'Developer tools',
    },
    hours: {
      notes:
        'The API runs on Cloudflare’s edge network and is available continuously. There are ' +
        'no support hours — this is a self-serve product.',
    },
    policies: {
      languages: ['Any language the visitor writes in'],
    },
  },

  widget_config: {
    theme: 'auto',
    position: 'bottom-right',
    greeting:
      'Ask me anything about ConverseKit — I answer from its own documentation, ' +
      'the same way your bot would answer from yours.',
    // Long enough that the panel is not fighting the hero for attention
    // on arrival, short enough to catch someone still reading it.
    greeting_delay_ms: 4000,
    show_typing: true,
    // On by default everywhere, and especially here: the citation IS
    // the demo. It shows a visitor that the answer came from a document
    // rather than from the model's memory.
    show_citations: true,
  },

  // Off. This bot exists to demonstrate answering, and a landing-page
  // widget that asks an evaluator for their phone number before they
  // have finished reading the page is the single fastest way to make
  // the demo feel like a trap. Lead capture is described in the FAQ
  // instead, which is the honest way to show a feature you have chosen
  // not to point at your own visitors.
  lead_config: {
    enabled: false,
  },
};

/**
 * Prose sources, chunked and embedded by the ordinary pipeline.
 *
 * Prose rather than FAQ rows because that is what it is: continuous
 * text where the useful passage for a given question is a paragraph
 * somewhere inside, which is precisely the case the sliding-window
 * chunker exists for. Splitting it into question/answer pairs would
 * mean inventing the questions.
 *
 * `title` is the identity used for idempotent reseeding — a source
 * whose title matches is replaced, not duplicated.
 */
export const DEMO_SOURCES = [
  {
    title: 'ConverseKit — features',
    source: 'markdown',
    content: `# What ConverseKit does

## Drop-in chat widget

One script tag, no build step. The widget renders into a shadow root, so no rule
on the host page reaches inside it and nothing it does leaks out. It styles
itself from the bot's brand colour, works on mobile, and is keyboard accessible.
Replies stream token by token over SSE, with an automatic fallback to a buffered
endpoint if the stream fails.

Once loaded it exposes \`window.ConverseKit\` with \`open()\`, \`close()\`,
\`toggle()\` and \`isOpen()\`, so a host page can drive the panel from its own
button rather than the launcher.

## Answers from your documents

Paste text or markdown, upload a file, or point it at a URL. Longer material is
chunked, embedded and searched at question time, and the answer cites what it
used. Retrieval is hybrid: a vector channel over pgvector and a lexical channel
over a Postgres full-text index, so a question phrased in words that appear
verbatim in your documents finds them even when the embedding is unhelpful.

FAQ entries are stored as individual rows rather than as one text blob, so each
is indexed, edited, reordered and disabled on its own, and a near-exact question
match can short-circuit retrieval entirely.

## Lead capture

The assistant collects a name, email or phone number when a visitor shows
intent, and files it as a lead you can export to CSV. Which fields it asks for,
when it asks, and what it says while asking are all per-bot settings. Captured
leads can be posted to a Slack or Teams webhook, or emailed to a distribution
list.

## Eleven AI vendors, one interface

OpenAI, Anthropic Claude, Google Gemini, Groq, OpenRouter, Mistral, Cloudflare
Workers AI, DeepSeek, Together AI, Ollama and LM Studio, plus any
OpenAI-compatible endpoint. Switching vendor is a dropdown, per bot, and the
conversation format does not change underneath it.

Each bot can carry its own vendor credentials. Keys are write-only through the
API: once stored they are never returned, and the dashboard shows only the last
few characters.

## Multi-tenant isolation

Row-level security in Postgres, keyed off organization membership, so two
organizations cannot see each other's bots, leads, documents or conversations.
The isolation is enforced by database policy rather than by application code,
and there is a test that authenticates as one organization and tries to read
another's records directly.

Each bot also carries a list of allowed origins. A chat request from anywhere
else is refused before the model is ever called, so a stolen bot id cannot be
used to run up someone else's bill from another site.

## Admin dashboard

A playground for testing changes before they go live, bot settings, a business
profile, the knowledge base, knowledge sources with a chunk inspector, retrieval
tuning with a preview of what a given question would actually retrieve, a miss
report showing questions the bot could not answer, provider selection, captured
leads, conversation transcripts, and usage.

## What it runs on

Cloudflare Workers with Hono for the API, Supabase Postgres with pgvector for
retrieval and row-level security, Cloudflare R2 for uploaded files, and Workers
AI for embeddings. The default chat model is Gemini Flash Lite.
`,
  },
];

/**
 * FAQ rows. Order here is the order in the dashboard and the position
 * written to the rows; the first few are what a visitor is most likely
 * to open with.
 *
 * Questions are the identity used for idempotent reseeding, matched
 * case-insensitively after trimming.
 */
export const DEMO_FAQ = [
  {
    question: 'How do I install it?',
    answer:
      'Create a bot in the dashboard, fill in what it should know, then paste the script tag ' +
      'with your bot id before the closing </body> tag of your site. There is nothing to ' +
      'install, bundle or compile.',
  },
  {
    question: 'Do I need to change my site’s build setup?',
    answer:
      'No. It is one script tag, and it works on a hand-written HTML page as readily as on a ' +
      'framework. The widget renders into a shadow root, so it cannot collide with your CSS ' +
      'and your CSS cannot break it.',
  },
  {
    question: 'What does it cost to run?',
    answer:
      'It can run at no cost. Gemini Flash Lite for chat and Cloudflare Workers AI for ' +
      'embeddings handle the whole loop — ingest, retrieve, answer — on free tiers, and that ' +
      'is the platform default for a new bot.',
  },
  {
    question: 'Which AI models can I use?',
    answer:
      'Eleven vendors are built in — OpenAI, Anthropic, Google, Groq, OpenRouter, Mistral, ' +
      'Cloudflare Workers AI, DeepSeek, Together, Ollama and LM Studio — plus any ' +
      'OpenAI-compatible endpoint, including local servers. Each bot picks its own vendor and ' +
      'model from a dropdown.',
  },
  {
    question: 'Can I use my own API key?',
    answer:
      'Yes. Each bot can carry its own vendor credentials. Keys are write-only through the ' +
      'API — once stored they are never returned, and the dashboard shows only the last few ' +
      'characters.',
  },
  {
    question: 'Why isn’t my widget answering?',
    answer:
      'Almost always the origin. The bot’s allowed origins must match the site’s origin ' +
      'exactly, including scheme and port, with no trailing slash or path. The second common ' +
      'cause is an empty knowledge base — the bot needs something to say.',
  },
  {
    question: 'How does it know about my business?',
    answer:
      'You provide it. Fill in the knowledge base fields, or add knowledge sources for ' +
      'anything longer. At question time your question is embedded and matched against your ' +
      'content by similarity, and the best passages are put into the prompt.',
  },
  {
    question: 'What happens if retrieval fails?',
    answer:
      'The turn still gets answered. A bot with no corpus, or an embedding vendor having a bad ' +
      'minute, falls back to the plain knowledge-base prompt rather than failing the visitor’s ' +
      'question.',
  },
  {
    question: 'Is my data separate from other customers’?',
    answer:
      'Yes. Isolation is enforced by row-level security policies in Postgres rather than by ' +
      'application code, and there is a test that authenticates as one organization and tries ' +
      'to read another’s records directly.',
  },
  {
    question: 'Can I see what the bot is actually retrieving?',
    answer:
      'Yes. The dashboard shows the chunks each document produced, lets you preview what a ' +
      'given question would retrieve before a visitor asks it, and lets you reindex a source ' +
      'after editing it.',
  },
  {
    question: 'Can I open the chat from my own button?',
    answer:
      'Yes. Once the widget has loaded it exposes window.ConverseKit with open(), close(), ' +
      'toggle() and isOpen(). The "Try it live" button on this page does exactly that.',
  },
  {
    question: 'What languages does it speak?',
    answer:
      'Whatever the visitor writes in. The system prompt tells the model to reply in the ' +
      'visitor’s own language, and the lexical side of retrieval uses an unstemmed ' +
      'configuration so it does not mangle non-English text.',
  },
];
