// ----------------------------------------------------------------
// The AURAK Coding Club bot — a real tenant, not platform furniture.
//
// Mirrors the shape of config/demo-bot.js deliberately: fixed ids so
// seeding and page-building stay independent, and the corpus declared
// here rather than pasted into the dashboard by hand, so a db:reset
// can be replayed rather than mourned.
//
// WHERE THE CORPUS LIVES. Unlike the demo bot, the prose is NOT inline
// below — it is in docs/coding-club/*.md and read at seed time. That is
// because this bot's knowledge is club facts that a human editor keeps
// current, and a markdown file is a far better editing surface than a
// JS string literal. Edit the markdown, re-run the seed.
//
// Sources marked TODO in those files are the ones GitHub could not
// answer: the org's Fall 2025 sections are still stubs upstream.
// ----------------------------------------------------------------
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE_DIR = join(ROOT, 'docs', 'coding-club');

/**
 * Fixed identifiers. `c10b` reads as "club" at a glance, the way the
 * demo bot's `d3f0` reads as "demo" — so a stray row in a table is
 * identifiable without a lookup.
 *
 * A separate org from the demo one and from any personal org: supabase/
 * 002 carries a unique index of one bot per organization.
 */
export const CLUB_ORG_ID = 'c10b0000-0000-4000-8000-000000000001';
export const CLUB_BOT_ID = 'c10b0000-0000-4000-8000-000000000002';

export const CLUB_ORG_NAME = 'AURAK Coding Club';

/**
 * Origins the widget/harness may call from.
 *
 * GitHub Pages serves the whole org from one origin, so the event page
 * and every other club site share it. localhost is here because the
 * harness page is developed before it is deployed, and an origin that
 * is not listed fails with a 403 the page cannot explain.
 */
export const CLUB_ORIGINS = [
  // Where the event page actually lives. It is a personal GitHub Pages
  // account rather than the club org's, and this list is the reason
  // that matters: a seed run that dropped this origin would 403 every
  // request from the live page, with no error the page could explain.
  'https://mukeremshifa.github.io',
  // The club org's Pages origin. Kept so the page can move onto the
  // org later without a reseed.
  'https://aurak-coding-club.github.io',
  'http://localhost:8080',
  'http://localhost:5500',
];

/**
 * The bot row. Column names, not camelCase — written to PostgREST as-is.
 */
export const CLUB_BOT = {
  name: 'AURAK Coding Club',
  business_name: 'AURAK Coding Club',

  // The phosphor green from the club's own Slide-Deck stylesheet
  // (#33ff66 on #171717). The club's design profile is already a retro
  // CRT terminal, which is why the harness page reads as native rather
  // than as a third-party widget bolted on.
  primary_color: '#33FF66',

  // Always in the prompt, whatever retrieval returns. Capped at 600
  // characters by src/config.ts.
  business_description:
    'The AURAK Coding Club is the student coding and technology club at the American ' +
    'University of Ras Al Khaimah in the UAE. It welcomes students of every major and ' +
    'skill level, from beginners to experienced programmers. Its flagship activity is Dev ' +
    'Discussions — deep-dive sessions on a computer science topic, held in G-201 and live ' +
    'streamed on Google Meet. It also runs weekly Tech Talk newsletters, Review Rounds ' +
    'exam-prep videos, competitions and typeathons, trips to tech events, and collaborations ' +
    'with other AURAK clubs. It has twice won the university’s Most Active Student Club Award.',

  custom_instructions:
    'You are the assistant for the AURAK Coding Club. The people asking are mostly AURAK ' +
    'students — many of them are meeting the club for the first time at an event, and some ' +
    'are not computing majors at all.\n\n' +
    'Be warm, brief and concrete. Two or three sentences is usually right. Name the actual ' +
    'programmes, people and dates rather than speaking in generalities.\n\n' +
    'If someone asks something your knowledge base does not cover — a date, a room, a ' +
    'result you were not given — say plainly that you do not know and point them at ' +
    'codingclub2024@aurak.ac.ae or a crew member. Never invent a meeting time, a deadline, ' +
    'a leaderboard position or a person’s role. A wrong answer about when the club meets ' +
    'is worse than no answer.\n\n' +
    'When someone sounds interested in joining, tell them membership is open to any major ' +
    'and any skill level, and give them the membership form link.',

  // The chips a visitor sees before typing. Four: a fifth wraps.
  // These are what a student at a stand actually walks up and asks.
  suggestions: [
    'What is a Dev Discussion?',
    'How do I join?',
    'What are Tech Titans?',
    'Do I need to know how to code?',
  ],

  profile: {
    identity: {
      legal_name: 'AURAK Coding Club',
      tagline: 'The student coding and technology club at AURAK',
      industry: 'Student organization',
    },
    location: {
      notes:
        'American University of Ras Al Khaimah, Ras Al Khaimah, United Arab Emirates. ' +
        'Dev Discussions are held in G-201, the AutoCAD lab, and live streamed on Google Meet.',
    },
    contact: {
      email: 'codingclub2024@aurak.ac.ae',
      links: [
        { label: 'GitHub', url: 'https://github.com/AURAK-Coding-Club' },
        { label: 'Tech Talk', url: 'https://aurak-coding-club.github.io/Tech-Talk/' },
        { label: 'Join as a member', url: 'https://forms.gle/U6LU6NtewL5aaAm88' },
        { label: 'Join the crew', url: 'https://forms.gle/ihToNcZaPbEqnthu5' },
      ],
    },
    policies: {
      languages: ['English'],
    },
  },

  widget_config: {
    theme: 'auto',
    position: 'bottom-right',
    greeting:
      'Ask me anything about the AURAK Coding Club — what we run, how to join, ' +
      'or what Tech Titans is.',
    greeting_delay_ms: 4000,
    show_typing: true,
    show_citations: true,
  },

  // Off. The audience is students at a stand, not sales leads, and a
  // bot that asks a passing student for their phone number is the
  // fastest way to make the demo feel like a trap.
  lead_config: {
    enabled: false,
  },
};

/**
 * Prose sources, read from docs/coding-club at seed time.
 *
 * Title is derived from the file's first `# ` heading, because title is
 * the identity the seed matches on for idempotent reseeding — deriving
 * it from the filename would make renaming a file silently duplicate
 * the source instead of replacing it.
 *
 * HTML comments are stripped: the TODO markers are notes to the editor,
 * not knowledge, and embedding them would let the bot cite them.
 */
export function clubSources() {
  return readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(KNOWLEDGE_DIR, file), 'utf8');
      const content = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
      const heading = /^#\s+(.+)$/m.exec(content);
      if (!heading) throw new Error(`${file} has no '# Title' heading — the seed matches sources on title.`);
      return { title: heading[1].trim(), source: 'markdown', content };
    });
}

/**
 * FAQ rows. Stored individually so each is indexed, reordered and
 * disabled on its own, and a near-exact question match can
 * short-circuit retrieval.
 *
 * These are deliberately the highest-traffic questions at a stand —
 * the ones where a fast, exactly-right answer matters more than a
 * retrieved paragraph.
 */
export const CLUB_FAQ = [
  {
    question: 'How do I join the Coding Club?',
    answer:
      'Fill in the membership form at https://forms.gle/U6LU6NtewL5aaAm88. Membership is ' +
      'open to every AURAK student, from any major and any skill level — there is no ' +
      'programming experience required. If you want to help run the club rather than just ' +
      'attend, there is a separate crew application at https://forms.gle/ihToNcZaPbEqnthu5',
  },
  {
    question: 'Do I need to know how to code to join?',
    answer:
      'No. The club is explicitly for beginners as well as experienced programmers, and ' +
      'members come from majors across the university — Mass Communication, Business, ' +
      'Architecture, Biotechnology and several engineering disciplines have all been on the ' +
      'club leaderboard, not just computing majors.',
  },
  {
    question: 'What is a Dev Discussion?',
    answer:
      'Dev Discussions are the club’s flagship activity — in-person deep-dive sessions on ' +
      'one computer science topic, held in G-201 (the AutoCAD lab) and live streamed on ' +
      'Google Meet. Past topics include cryptography, Vim, Sonic Pi live-coding music, ' +
      'Unreal Engine and TeX internals. Each mixes a taught breakdown with a live demo, a ' +
      'Mentimeter quiz and often a typeathon — bring a laptop. Attending is worth a x4 ' +
      'multiplier on the Tech Titans leaderboard, and showcasing your own project is x16.',
  },
  {
    question: 'What is Tech Talk?',
    answer:
      'The club’s weekly tech-focused newsletter, published as a magazine with news, ' +
      'announcements, projects, polls and programming memes. You can read it at ' +
      'https://aurak-coding-club.github.io/Tech-Talk/ and you can be featured in it — email ' +
      'a piece on any topic that inspires you to codingclub2024@aurak.ac.ae.',
  },
  {
    question: 'What are Tech Titans?',
    answer:
      'A semesterly leaderboard that rewards taking part in club activities. Everyone starts ' +
      'at 1 point and multiplies up: x4 for attending a Dev Discussion, x8 for winning a ' +
      'typeathon, x16 for showcasing a project, x32 for placing in an official competition. ' +
      'The top three each semester get Coding Club Tech Titan certificates.',
  },
  {
    question: 'What is Review Rounds?',
    answer:
      'Review videos posted to the club’s YouTube channel to help AURAK students prepare ' +
      'for their midterm and final exams.',
  },
  {
    question: 'How do I contact the club?',
    answer:
      'Email codingclub2024@aurak.ac.ae, or find the club on GitHub at ' +
      'https://github.com/AURAK-Coding-Club. You can also speak to any crew member directly.',
  },
  {
    question: 'Has the club won anything?',
    answer:
      'Yes — the club has won AURAK’s Most Active Student Club Award twice, for Spring 2024 ' +
      'and Fall 2024.',
  },
];
