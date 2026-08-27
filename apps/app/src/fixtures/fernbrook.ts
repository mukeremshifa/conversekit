// ----------------------------------------------------------------
// Fernbrook Veterinary — the one fictional tenant every landing-page
// screenshot shows.
//
// Invented wholesale and approved as synthetic. The conventions that
// keep it safe are deliberate and worth keeping: phone numbers come
// from the 555-01xx range reserved for fiction, `fernbrookvet.com`
// resolves to nothing, and every surname is an invented compound.
// No real business, customer or person appears anywhere in here.
//
// TYPED AGAINST THE REAL INTERFACES, on purpose. `npm run build` in
// dashboard/ runs `tsc -b` over src/, so an API shape that changes
// under these fixtures fails the build instead of quietly producing
// fourteen screenshots of a screen nobody ships any more.
//
// DETERMINISM IS THE POINT. Every number below is either a literal or
// derived from a seeded formula — no Math.random(), no `new Date()`.
// A re-shoot has to produce byte-identical images, or the content
// hashes churn and every shoot is a diff.
// ----------------------------------------------------------------
import type {
  Bot, Doc, FaqItem, FaqResponse, Lead, Me, Message, Org, Stats, Vendor,
} from '@/lib/api';

/**
 * The instant every shot is taken at.
 *
 * The shot harness froze `Date.now()` to this value in every page it
 * drove, because three things read the wall clock and would otherwise
 * change the pixels from one run to the next: the widget's profile card
 * bolds *today's* row of opening hours, `formatDate` renders in the
 * browser's zone, and the charts label their axis in the browser's
 * locale. It also pinned the timezone to the clinic's own
 * (America/Los_Angeles) and the locale to en-US.
 *
 * It is Tuesday 08:20 in Ashfield — inside the clinic's morning
 * session, which is what makes the widget's hours card show an open
 * business rather than a closed one.
 *
 * Any future harness has to freeze the clock to this same instant, or
 * the hours card and the chart axes stop matching the shots already
 * deployed under /shots/.
 */
export const SHOT_NOW_ISO = '2026-08-18T15:20:00.000Z';
const NOW_MS = Date.parse(SHOT_NOW_ISO);

/** Wall-clock offsets, written the way the plan describes the rows
 *  ("2h", "1d") rather than as thirty opaque ISO strings. */
const hoursAgo = (h: number) => new Date(NOW_MS - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

export const BOT_ID = 'b0700001-0000-4000-8000-0000000000f1';
const ORG_ID = 'b0700001-0000-4000-8000-0000000000e1';
const USER_ID = 'b0700001-0000-4000-8000-0000000000d1';

/** The real platform default, per wrangler.toml — not a prettier model
 *  picked for the screenshot. A shot that shows a configuration nobody
 *  gets by default is a shot that lies. */
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBED_VENDOR = 'workers-ai';

// ── Account ──────────────────────────────────────────────────────

export const org: Org = {
  id: ORG_ID,
  name: 'Fernbrook Veterinary',
  slug: 'fernbrook-veterinary',
  plan: 'pro',
  role: 'owner',
};

export const me: Me = {
  userId: USER_ID,
  email: 'hello@fernbrookvet.com',
  orgs: [org],
};

// ── The bot ──────────────────────────────────────────────────────
//
// The six legacy columns are null and `profile` is populated, which is
// the shape a tenant who signs up today ends up with. Leaving the
// legacy columns set would put a "move your old fields in here" banner
// across the top of the Business Profile shot.

export const bot: Bot = {
  id: BOT_ID,
  org_id: ORG_ID,
  name: 'Fern',
  business_name: 'Fernbrook Veterinary',
  hours: null,
  location: null,
  contact: null,
  services: null,
  custom_instructions: null,
  primary_color: '#0F766E',
  allowed_origin: null,
  allowed_origins: ['https://fernbrookvet.com', 'https://www.fernbrookvet.com'],
  suggestions: ['Do you see rabbits?', 'First visit cost', 'Saturday hours'],
  created_at: daysAgo(214),
  business_description:
    'A family veterinary practice on Fernbrook Road, caring for cats, dogs, rabbits and small pets since 2009.',
  faq: null,
  contact_email: null,
  contact_phone: null,
  address: null,
  profile: {
    identity: {
      legal_name: 'Fernbrook Veterinary',
      tagline: 'A family veterinary practice on Fernbrook Road.',
      industry: 'Veterinary clinic',
    },
    location: {
      line1: '214 Fernbrook Road',
      city: 'Ashfield',
      region: 'OR',
      postal: '97402',
      country: 'US',
      parking: 'Free lot behind the building, entrance on Larkspur Lane.',
    },
    contact: {
      phone: '+1 (555) 0148',
      email: 'hello@fernbrookvet.com',
    },
    hours: {
      timezone: 'America/Los_Angeles',
      // Two intervals on every weekday. It exercises HoursInterval[]
      // rather than the one-span case, and a split day is what a real
      // clinic's board actually says.
      regular: {
        mon: [{ open: '08:00', close: '12:30' }, { open: '13:30', close: '18:30' }],
        tue: [{ open: '08:00', close: '12:30' }, { open: '13:30', close: '18:30' }],
        wed: [{ open: '08:00', close: '12:30' }, { open: '13:30', close: '18:30' }],
        thu: [{ open: '08:00', close: '12:30' }, { open: '13:30', close: '18:30' }],
        fri: [{ open: '08:00', close: '12:30' }, { open: '13:30', close: '18:30' }],
        sat: [{ open: '09:00', close: '13:00' }],
        // Sunday is absent rather than empty — that is how a closed day
        // is stored, and profilePublicCard only emits days with spans.
      },
      // One row, so the exceptions table is not an empty state in the
      // Business Profile shot.
      exceptions: [
        { date: '2026-11-26', closed: true, label: 'Thanksgiving' },
      ],
      notes: 'Closed for lunch 12:30–13:30. Emergencies are triaged by phone.',
    },
    links: {
      booking_url: 'https://fernbrookvet.com/book',
      pricing_url: 'https://fernbrookvet.com/services',
    },
    policies: {
      payment_methods: ['Visa', 'Mastercard', 'Cash', 'Pet-insurance direct billing'],
      cancellation: "24 hours' notice, or the deposit is retained.",
      languages: ['English', 'Spanish'],
    },
  },
  provider_config: {
    vendor: 'google',
    model: 'gemini-3.5-flash-lite',
    hasApiKey: true,
    apiKeyLast4: '9f2c',
  },
  embedding_config: {
    vendor: EMBED_VENDOR,
    model: EMBED_MODEL,
    dimensions: 768,
  },
  rag_config: {
    enabled: true,
    top_k: 6,
    retrieval_mode: 'hybrid',
    router: 'on',
    faq_shortcut_threshold: 0.82,
  },
  widget_config: {
    position: 'bottom-right',
    theme: 'light',
    greeting: "Hi! I'm Fern. Ask me anything about the clinic — hours, prices, or what we can see.",
    show_typing: true,
    show_citations: false,
  },
  behavior_config: {
    max_messages: 40,
    escalate_after_misses: 2,
  },
  lead_config: {
    enabled: true,
    trigger: 'intent',
    fields: { phone: 'optional', company: 'off', inquiry: 'required' },
    booking_url: 'https://fernbrookvet.com/book',
    has_webhook: false,
    webhook_host: null,
  },
  logo_url: null,
  // NULL, like every bot that signed up after 011: there was never a
  // prompt-pasted FAQ to move, so the Knowledge Base carries neither the
  // "move your old content" banner nor the "using the knowledge base /
  // Revert" one. Both are migration furniture, and a shot of them is a
  // shot of the platform's history rather than of the product.
  knowledge_migrated_at: null,
};

// ── Providers ────────────────────────────────────────────────────
// Only Google carries a key, which is the honest picture of a tenant
// who picked one vendor and left the rest alone.

export const vendors: Vendor[] = [
  { id: 'google', label: 'Google Gemini', costTier: 'free-tier', defaultChatModel: 'gemini-3.5-flash-lite', defaultEmbedModel: 'text-embedding-004', embedDimensions: 768, supportsEmbeddings: true, requiresKey: true, requiresBaseUrl: false, keyConfigured: true },
  { id: 'openai', label: 'OpenAI', costTier: 'paid', defaultChatModel: 'gpt-4o-mini', defaultEmbedModel: 'text-embedding-3-small', embedDimensions: 1536, supportsEmbeddings: true, requiresKey: true, requiresBaseUrl: false, keyConfigured: false },
  { id: 'anthropic', label: 'Anthropic Claude', costTier: 'paid', defaultChatModel: 'claude-haiku-4-5-20251001', defaultEmbedModel: null, embedDimensions: null, supportsEmbeddings: false, requiresKey: true, requiresBaseUrl: false, keyConfigured: false },
  { id: 'groq', label: 'Groq', costTier: 'free-tier', defaultChatModel: 'llama-3.3-70b-versatile', defaultEmbedModel: null, embedDimensions: null, supportsEmbeddings: false, requiresKey: true, requiresBaseUrl: false, keyConfigured: false },
  { id: 'workers-ai', label: 'Cloudflare Workers AI', costTier: 'free-tier', defaultChatModel: '@cf/meta/llama-3.1-8b-instruct', defaultEmbedModel: EMBED_MODEL, embedDimensions: 768, supportsEmbeddings: true, requiresKey: false, requiresBaseUrl: false, keyConfigured: true },
  { id: 'ollama', label: 'Ollama', costTier: 'local', defaultChatModel: 'llama3.1', defaultEmbedModel: 'nomic-embed-text', embedDimensions: 768, supportsEmbeddings: true, requiresKey: false, requiresBaseUrl: true, keyConfigured: false },
];

// ── The 30-day series ────────────────────────────────────────────
//
// Generated, not typed out. A hand-written month either has a visible
// pattern or a flat run, and both read as fake at a glance.
//
// The shape is a weekday rhythm (a clinic is quiet at weekends), a
// gentle climb across the month so every delta against the previous
// window is up, and a small deterministic wobble on top.
//
// The counts are then fitted to the exact totals below by largest
// remainder, so the tiles and the bars are telling the same story: the
// series sums to `sessions 1284` because it was *made* to, not because
// a generator happened to land there.

/** mulberry32 — 32 bits of state, uniform enough for a wobble, and
 *  identical on every machine and every Node version. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split `total` across `weights` as whole numbers that sum to exactly
 * `total`. Largest remainder: floor everything, then hand the leftover
 * units to the days with the biggest fractional parts, ties broken by
 * index so the result never depends on sort stability.
 */
function share(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map(Math.floor);
  const leftover = total - out.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((v, i) => [v - Math.floor(v), i] as const)
    .sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (let i = 0; i < leftover; i++) out[byRemainder[i][1]]++;
  return out;
}

const DAYS = 30;

/** The `days` window ending on the anchor day, in UTC — the API buckets
 *  in UTC and the Overview says so in its footnote. */
function windowDates(days: number): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(NOW_MS - i * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

function buildSeries() {
  const dates = windowDates(DAYS);
  const rnd = seeded(0x0fe68b00);

  const weight = dates.map((iso, i) => {
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const trend = 0.86 + (i / (DAYS - 1)) * 0.3;
    return (weekend ? 16 : 45) * trend * (0.9 + rnd() * 0.2);
  });

  const sessions = share(1284, weight);
  // Visitor turns get their OWN wobble rather than a fixed multiple of
  // sessions: a constant ratio draws the "turns per conversation" chart
  // as a dead flat line, which is the one panel whose whole job is to
  // show that conversations vary in depth.
  const visitor = share(5906, sessions.map((s) => s * (0.88 + rnd() * 0.24)));
  const assistant = share(5930, visitor.map((v) => v * (0.96 + rnd() * 0.08)));
  const leads = share(216, sessions.map((s) => s * (0.72 + rnd() * 0.56)));

  return dates.map((date, i) => ({
    date,
    sessions: sessions[i],
    visitor: visitor[i],
    assistant: assistant[i],
    leads: leads[i],
  }));
}

const series = buildSeries();

export const stats: Stats = {
  range: {
    days: DAYS,
    from: series[0].date,
    to: series[series.length - 1].date,
  },
  totals: {
    sessions: 1284,
    messages: 11836,
    visitorMessages: 5906,
    assistantMessages: 5930,
    leads: 216,
    conversionRate: 216 / 1284,
    turnsPerSession: 5906 / 1284,
    documents: 6,
    documentsReady: 5,
    documentsFailed: 0,
    documentsPending: 1,
    chunks: 124,
  },
  // Every delta is up. A marketing screenshot showing a bot in decline
  // is a strange thing to ship.
  previous: { sessions: 1043, messages: 9402, leads: 168 },
  series,
  topQuestions: [
    { text: 'Do you take walk-ins?', count: 214 },
    { text: 'How much is a first visit?', count: 186 },
    { text: 'Are you open on Saturday?', count: 171 },
    { text: 'Do you see rabbits?', count: 133 },
    { text: 'Do you do dental cleanings?', count: 118 },
    { text: 'Can I get flea treatment without an appointment?', count: 97 },
    { text: 'Do you take pet insurance?', count: 84 },
  ],
  truncated: { messages: false, leads: false },
};

// ── Leads ────────────────────────────────────────────────────────
//
// Talia is the newest row here AND the visitor in the widget shot: the
// two images tell one story, and somebody will notice. The two null
// phones are deliberate — the table has to show that a lead can arrive
// partial.

const SESSION = (n: number) => `b0700001-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

// The ages are given in hours rather than in the days the plan lists
// them by, and no two are the same: the table renders an absolute
// timestamp, and two leads stamped to the identical minute is the one
// detail in these ten rows that reads as generated.
export const leads: Lead[] = [
  { id: 'ld-01', name: 'Talia Hallowell', email: 't.hallowell@gmail.com', phone: '(555) 0142', inquiry: "Saturday morning slot for a kitten's first shots", created_at: hoursAgo(2), session_id: SESSION(1) },
  { id: 'ld-02', name: 'Marcus Brackenbury', email: 'marcus.b@outlook.com', phone: '(555) 0117', inquiry: 'Second opinion on a limping retriever', created_at: hoursAgo(5), session_id: SESSION(2) },
  { id: 'ld-03', name: 'Priya Nandakumar', email: 'p.nandakumar@gmail.com', phone: '(555) 0163', inquiry: 'Do you microchip rabbits?', created_at: hoursAgo(24), session_id: SESSION(3) },
  { id: 'ld-04', name: 'Dev Okonjo-Reyes', email: 'dev.okonjo@icloud.com', phone: null, inquiry: 'Boarding over the holidays', created_at: hoursAgo(31), session_id: SESSION(4) },
  { id: 'ld-05', name: 'Hannah Wexley', email: 'hwexley@gmail.com', phone: '(555) 0129', inquiry: 'Dental cleaning quote for a 9-year-old cat', created_at: hoursAgo(46), session_id: SESSION(5) },
  { id: 'ld-06', name: 'Tomás Iriarte', email: 't.iriarte@outlook.com', phone: '(555) 0155', inquiry: 'Puppy vaccination schedule', created_at: hoursAgo(53), session_id: SESSION(6) },
  { id: 'ld-07', name: 'Nell Arboghast', email: 'nell.arboghast@gmail.com', phone: '(555) 0108', inquiry: 'Flea treatment without an appointment?', created_at: hoursAgo(69), session_id: SESSION(7) },
  { id: 'ld-08', name: 'Yusuf Demirbaş', email: 'y.demirbas@icloud.com', phone: '(555) 0171', inquiry: 'Anyone available after 6pm?', created_at: hoursAgo(77), session_id: SESSION(8) },
  { id: 'ld-09', name: 'Cora Villanueva-Platt', email: 'cora.vp@gmail.com', phone: null, inquiry: 'Transferring records from another clinic', created_at: hoursAgo(93), session_id: SESSION(9) },
  { id: 'ld-10', name: 'Bram Osterhout', email: 'b.osterhout@outlook.com', phone: '(555) 0134', inquiry: 'Senior wellness package pricing', created_at: hoursAgo(101), session_id: SESSION(10) },
];

// ── Knowledge sources ────────────────────────────────────────────
//
// The `processing` row shows the ingestion pipeline alive rather than
// static. A `failed` row would show it broken, which is a different
// thing to put on a marketing page.
//
// Every ready row carries the SAME embedding_model the endpoint reports
// as current, or the Sources screen puts a red "Re-index required"
// banner across the top of the shot.

const ready = (over: Partial<Doc> & Pick<Doc, 'id' | 'title' | 'source' | 'chunk_count' | 'created_at'>): Doc => ({
  bot_id: BOT_ID,
  url: null,
  status: 'ready',
  error: null,
  embedding_model: EMBED_MODEL,
  embedding_dimensions: 768,
  ...over,
});

export const documents: Doc[] = [
  ready({ id: 'doc-01', title: 'Services & pricing', source: 'url', url: 'https://fernbrookvet.com/services', chunk_count: 34, created_at: daysAgo(96) }),
  ready({ id: 'doc-02', title: 'New patient FAQ', source: 'faq', chunk_count: 22, created_at: daysAgo(96) }),
  ready({ id: 'doc-03', title: 'Vaccination schedules 2026', source: 'file', chunk_count: 41, created_at: daysAgo(62), mime_type: 'application/pdf', size_bytes: 290_816, r2_key: 'docs/fernbrook/vaccination-schedules-2026.pdf' }),
  ready({ id: 'doc-04', title: 'Boarding & daycare policy', source: 'markdown', chunk_count: 18, created_at: daysAgo(41) }),
  ready({ id: 'doc-05', title: 'After-hours & emergencies', source: 'text', chunk_count: 9, created_at: daysAgo(23) }),
  {
    id: 'doc-06',
    bot_id: BOT_ID,
    source: 'file',
    title: 'Post-op care sheets',
    url: null,
    status: 'processing',
    error: null,
    chunk_count: 0,
    embedding_model: null,
    embedding_dimensions: null,
    created_at: hoursAgo(1),
    mime_type: 'application/pdf',
    size_bytes: 512_000,
    r2_key: 'docs/fernbrook/post-op-care-sheets.pdf',
  },
];

export const embedding = { vendor: EMBED_VENDOR, model: EMBED_MODEL };

// ── FAQ ──────────────────────────────────────────────────────────

const faqItem = (n: number, question: string, answer: string): FaqItem => ({
  id: `faq-${String(n).padStart(2, '0')}`,
  bot_id: BOT_ID,
  document_id: 'doc-02',
  question,
  answer,
  position: n,
  enabled: true,
  created_at: daysAgo(96),
  updated_at: daysAgo(96 - n),
});

export const faq: FaqResponse = {
  items: [
    faqItem(1, 'Do you take walk-ins?', 'Yes, for urgent problems between 08:00 and 11:30 on weekdays. Everything else is by appointment — the wait for a walk-in can be long.'),
    faqItem(2, 'How much is a first visit?', 'A first exam is $65 and covers a dental check, weight and nail trim. Vaccinations and tests are quoted separately.'),
    faqItem(3, 'Do you see rabbits?', 'Yes. Dr. Amara Osei sees rabbits and guinea pigs, usually Tuesdays and Thursdays.'),
    faqItem(4, 'Do you take pet insurance?', 'We bill most major insurers directly. Bring your policy number to the first visit.'),
    faqItem(5, 'What happens out of hours?', 'Calls are triaged by phone. Genuine emergencies are referred to Ashfield Animal Emergency on Larkspur Lane.'),
  ],
  document: documents[1],
  limits: { items: 100, question: 200, answer: 2000 },
};

// ── Conversations ────────────────────────────────────────────────
//
// Written oldest-first per session, because that is the only order a
// conversation can be read in — and exported newest-first, because that
// is what the API returns and what Transcript.orderedForReading is
// written against. Hand it the wrong way round and the screen renders
// every session backwards, with the bot answering before it was asked.
//
// The first session is Talia's: the same conversation the widget shot
// is showing, seen from the operator's side.

// No two turns may share a minute. The export below sorts by
// created_at, and a tie there lands two messages in whichever order the
// sort happens to leave them — which, once the screen reverses the list
// for reading, showed the bot thanking Talia before she had answered.
let messageSeq = 0;
const turn = (session: number, role: Message['role'], content: string, minutesAgo: number): Message => ({
  id: `msg-${String(++messageSeq).padStart(3, '0')}`,
  session_id: SESSION(session),
  role,
  content,
  created_at: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
});

const turns: Message[] = [
  turn(1, 'user', 'Do you see rabbits?', 130),
  turn(1, 'assistant', 'Yes — Dr. Amara Osei sees rabbits, usually Tuesdays and Thursdays. A first exam is $65. Shall I take your details for a call back?', 129),
  turn(1, 'user', 'Yes please — Talia Hallowell', 128),
  turn(1, 'assistant', "Thanks, Talia. What's the best number or email to reach you on?", 127),
  turn(1, 'user', 't.hallowell@gmail.com, or (555) 0142', 125),
  turn(1, 'assistant', "Got it — the front desk will call you about a Saturday morning slot for the kitten's first shots. Anything else I can check for you?", 124),

  turn(2, 'user', 'my retriever is limping, can someone look at him today', 311),
  turn(2, 'assistant', 'A new limp is worth seeing quickly. We keep urgent walk-in slots between 08:00 and 11:30 on weekdays — bring him in and the front desk will triage. If he cannot bear weight at all, call us first on (555) 0148.', 310),
  turn(2, 'user', "It's a second opinion really, he was seen elsewhere last week", 308),
  turn(2, 'assistant', "That's fine — bring any notes or x-rays you were given. Would you like me to take your details so we can book you in?", 307),
  turn(2, 'user', 'Marcus Brackenbury, (555) 0117', 306),

  turn(3, 'user', 'do you microchip rabbits?', 1_460),
  turn(3, 'assistant', "Yes, we microchip rabbits as well as cats and dogs. It's a quick appointment and can be done at the same visit as a health check.", 1_459),
  turn(3, 'user', 'how much?', 1_458),
  turn(3, 'assistant', "Microchipping is $28 on its own, or included in the annual wellness package. I can't book it for you here, but I can pass your details to the front desk — would that help?", 1_457),
];

export const conversations: Message[] = [...turns]
  .sort((a, b) => b.created_at.localeCompare(a.created_at));

// ── The widget shot ──────────────────────────────────────────────
//
// The widget's own view of this tenant. Shaped exactly like the
// response `GET /v1/bots/:id/health` returns — camelCase, only the keys
// a tenant actually set, and the profile already reduced to the card
// the widget can render (see profilePublicCard in src/profile.ts).
//
// Note the colour: this is Fernbrook's teal, not ConverseKit's gold.
// The live widget in the corner of the landing page IS gold, and the
// difference between the two is the point — the widget takes its colour
// from the bot it belongs to.

export const health = {
  status: 'ok',
  botId: BOT_ID,
  name: bot.name,
  businessName: bot.business_name,
  contact: '+1 (555) 0148',
  primaryColor: bot.primary_color,
  suggestions: bot.suggestions,
  streaming: true,
  widget: {
    position: 'bottom-right',
    theme: 'light',
    greeting: bot.widget_config?.greeting,
    showTyping: true,
  },
  profile: {
    address: '214 Fernbrook Road, Ashfield, OR 97402, US',
    phone: '+1 (555) 0148',
    email: 'hello@fernbrookvet.com',
    booking: 'https://fernbrookvet.com/book',
    hours: {
      timezone: 'America/Los_Angeles',
      // Pre-rendered spans, which is what the API sends: the widget
      // renders these strings, it does not parse intervals.
      regular: {
        mon: ['08:00–12:30', '13:30–18:30'],
        tue: ['08:00–12:30', '13:30–18:30'],
        wed: ['08:00–12:30', '13:30–18:30'],
        thu: ['08:00–12:30', '13:30–18:30'],
        fri: ['08:00–12:30', '13:30–18:30'],
        sat: ['09:00–13:00'],
      },
      notes: 'Closed for lunch 12:30–13:30.',
    },
  },
};

/**
 * The scripted conversation, keyed by what the visitor sends.
 *
 * The harness replays it through the REAL widget — the visitor's lines
 * are typed into the real composer and the replies come back over a
 * stubbed /v1/chat/stream — so what the screenshot shows is the widget
 * rendering a conversation, not a mock-up of one.
 *
 * "Do you see rabbits?" is also the first suggestion chip and the
 * fourth top question in the Overview shot, and the answer is FAQ item
 * 3 nearly verbatim. That is the retrieval story told once and shown
 * three times.
 */
export const transcript: { ask: string; reply: string }[] = [
  {
    ask: 'Do you see rabbits?',
    reply:
      'Yes — Dr. Amara Osei sees rabbits, usually Tuesdays and Thursdays. '
      + 'A first exam is $65. Shall I take your details for a call back?',
  },
  {
    ask: 'Yes please — Talia Hallowell',
    reply: "Thanks, Talia. What's the best number or email to reach you on?",
  },
];
