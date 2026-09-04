#!/usr/bin/env node
/**
 * Builds offline-cache.json for the AURAK Coding Club event terminal.
 *
 *   node scripts/build-offline-cache.mjs [outPath]
 *
 * WHY THIS IS A SCRIPT AND NOT A HAND-WRITTEN JSON FILE. The cache is
 * derived from docs/coding-club/*.md, and the brief that requested it
 * says to regenerate rather than hand-patch when the corpus changes.
 * A script makes that a command; a checked-in blob makes it an
 * archaeology exercise. It also stamps the corpus commit sha into
 * `source`, so the page can tell whether the cache has drifted from
 * what the live bot answers.
 *
 * WHAT THIS IS NOT. There is no inference here. The event page does
 * keyword matching against each entry's `questions` array and replays
 * the stored `answer` — so the entries below are written by hand
 * against the corpus, and this file's job is assembly, validation and
 * the size/shape guarantees the consuming page depends on.
 *
 * EVERY CLAIM BELOW IS TRACEABLE TO THE CORPUS. Where the corpus does
 * not support an answer — the current semester's schedule, exact
 * meeting times, live leaderboard standings — the entry says so and
 * points at the club email, which is what the live bot does. Inventing
 * one to fill a gap would put a confident wrong answer in front of a
 * queue of students.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'offline-cache.json'));

// ---------------------------------------------------------------
// Source titles.
//
// These must match the corpus document titles BYTE FOR BYTE, because
// the page renders them as a tool trace (`⎿ read: …`) exactly as the
// live path does. A citation that does not name a real document is a
// lie told to an audience, so they are validated against the real
// titles at the bottom of this file rather than trusted.
//
// `Frequently Asked Questions` is the FAQ document the ingest pipeline
// generates from the FAQ rows — it is not a file in docs/coding-club,
// which is why it is listed separately here.
// ---------------------------------------------------------------
const SRC = {
  about: 'About the AURAK Coding Club',
  joining: 'Joining the club, and getting in touch',
  crew: 'The club crew',
  titans: 'Tech Titans — the club leaderboard',
  history: 'Club history and achievements',
  projects: 'Club projects and repositories',
  dd: "Dev Discussions — the club's flagship activity",
  faq: 'Frequently Asked Questions',
};

/** The FAQ doc is generated, not a file; everything else must exist. */
const FILE_BACKED = ['about', 'joining', 'crew', 'titans', 'history', 'projects', 'dd'];

const e = (id, questions, answer, citations, tags) => ({ id, questions, answer, citations, tags });

// ================================================================
// 1. DEV DISCUSSIONS — the flagship. ~25% of entries.
// ================================================================
const devDiscussions = [
  e('dd-what',
    ['What is a Dev Discussion?', 'what are dev discussions', 'tell me about dev discussions',
     'what happens at a dev discussion', 'whats a devdiscussion', 'dev discussion'],
    "Dev Discussions are our flagship activity — in-person deep dives into one computer science topic, held in G-201 and live streamed on Google Meet. Past sessions have covered cryptography, theory of computation, live-coding music in Sonic Pi, Unreal Engine, Vim and the internals of TeX.\n\nA session runs about an hour and mixes a taught breakdown with a live project demo, an interactive Mentimeter quiz and often a typeathon. Bring a laptop. Turning up earns you a x4 multiplier on the Tech Titans leaderboard, and showcasing your own project earns x16.",
    [SRC.dd], ['dev-discussions', 'flagship', 'events']),

  e('dd-hour',
    ['What actually happens in the hour?', 'what is the format', 'how is a session structured',
     'what do you do in a dev discussion', 'whats the agenda', 'session format'],
    "Each session opens with a short introduction, then spends most of the hour on a taught breakdown of the topic. After that there is usually a live demo — someone building or running the thing on screen — followed by a Mentimeter quiz that the room answers together, and often a typeathon to close.\n\nThe Vim session in October ran exactly this way: five minutes of introduction, thirty minutes of breakdown, fifteen on Mentimeter and ten on the typeathon.",
    [SRC.dd], ['dev-discussions', 'format']),

  e('dd-where',
    ['Where are they held?', 'where is g-201', 'what room', 'which lab', 'where do you meet',
     'location', 'g201'],
    "In G-201, the AutoCAD lab on the AURAK campus. That has been the home room for essentially every Dev Discussion we have run.\n\nIf you cannot make it in person, sessions are live streamed on Google Meet, so you can follow along from anywhere.",
    [SRC.dd, SRC.joining], ['dev-discussions', 'location', 'g-201']),

  e('dd-online',
    ['Can I attend online?', 'is it streamed', 'google meet', 'can i join remotely',
     'do you record sessions', 'remote'],
    "Yes — every Dev Discussion is live streamed on Google Meet so members who cannot attend in person can still follow along. Sessions have been broadcast this way since early on.\n\nComing in person is better if you can, though. The Mentimeter quizzes and typeathons are a lot more fun in a room full of people, and bringing a laptop lets you follow along hands-on.",
    [SRC.dd], ['dev-discussions', 'online', 'stream']),

  e('dd-beginner',
    ['Can beginners come to a Dev Discussion?', 'is it too advanced', 'i am a beginner',
     'do i need to be good at coding to attend', 'will i understand it', 'too hard for me'],
    "Absolutely. The sessions are pitched as introductions to a topic, not as lectures for people who already know it — the Vim session was billed as an introductory crash course, and the Sonic Pi one started from what a waveform is.\n\nWe are a club that welcomes complete beginners alongside experienced programmers, and nobody is going to test you at the door. Come along and see.",
    [SRC.dd, SRC.about], ['dev-discussions', 'beginners']),

  e('dd-prepare',
    ['Do I need to prepare anything?', 'what should i bring', 'do i need a laptop',
     'do i need to read anything first', 'byod', 'preparation'],
    "Just bring a laptop if you have one — several sessions have been explicitly bring-your-own-device, and the hands-on parts are much better when you can follow along.\n\nThere is no reading to do beforehand. Each session is self-contained and starts from the basics of its topic.",
    [SRC.dd], ['dev-discussions', 'preparation', 'laptop']),

  e('dd-topics',
    ['What topics have you covered?', 'past dev discussions', 'previous sessions',
     'what have you talked about', 'past topics', 'what subjects'],
    "A wide range. Cryptography and applied number theory, regular languages and theory of computation, live-coding music with Sonic Pi alongside the Music Club, markup languages including Markdown, HTML and LaTeX, game development in Unreal Engine, a Vim crash course, and a session unpacking the low-level behaviour of TeX.\n\nThe common thread is extracurricular computer science — things you would not normally meet in a course.",
    [SRC.dd], ['dev-discussions', 'topics', 'history']),

  e('dd-vim',
    ['Tell me about the Vim session', 'vim crash course', 'did you do vim', 'vim'],
    "The Vim Crash Course ran on 23rd October 2025 in G-201, presented by Mohammed Alshamsi — known around here as the resident flying whale.\n\nIt covered modal editing, the navigation and motion grammar, the operator-plus-text-object grammar that makes Vim composable, and then went further into registers, macros, marks and batch commands. It closed with a Mentimeter round and a typeathon.",
    [SRC.dd], ['dev-discussions', 'vim', 'topics']),

  e('dd-crypto',
    ['Tell me about the cryptography session', 'crypto dev discussion', 'number theory',
     'did you cover encryption', 'rsa'],
    "Our first Dev Discussion, on 14th March 2024 in G-201, presented by Mohammed Alshamsi. It went from divisibility and the Euclidean algorithm through primes, modular arithmetic and Euler's totient function, and used all of it to build up to real ciphers.\n\nThe session covered the Caesar and affine ciphers and then RSA itself, and the Mentimeter round had the room decrypting messages by hand.",
    [SRC.dd], ['dev-discussions', 'cryptography', 'topics']),

  e('dd-music',
    ['Tell me about the music session', 'sonic pi', 'sound of code', 'music club collab',
     'live coding music'],
    "Experience the Sound of Code ran on 28th October 2024 with the Music Club — an introduction to Sonic Pi, the open-source live-coding music environment built on Ruby.\n\nIt covered synths, loops and conditionals, then built up to real pieces: a multi-threaded cover of He's a Pirate with reverb and a bit-crushed bassline, Twinkle Twinkle, and note sequences generated straight out of a sine function.",
    [SRC.dd], ['dev-discussions', 'sonic-pi', 'music', 'topics']),

  e('dd-demo',
    ['Can I present at a Dev Discussion?', 'how do i showcase my project',
     'can i show my own work', 'i want to present', 'demo my project'],
    "Yes, and we would like you to. Showcasing a project at a Dev Discussion is worth a x16 multiplier on the Tech Titans leaderboard — the largest single award short of winning a competition outright.\n\nSessions regularly include a project demonstration slot. Talk to a crew member or email codingclub2024@aurak.ac.ae to get yourself on an agenda.",
    [SRC.dd, SRC.titans], ['dev-discussions', 'projects', 'presenting']),

  e('dd-missed',
    ['What if I miss one?', 'i missed a dev discussion', 'can i catch up',
     'are there notes', 'materials', 'slides'],
    "The agendas, handouts and slides for our sessions are kept in the Dev Discussions repository on our GitHub, so you can catch up on what was covered.\n\nSessions are also live streamed on Google Meet, so if you know in advance that you cannot be in the room, you can still join from wherever you are.",
    [SRC.dd, SRC.projects], ['dev-discussions', 'materials', 'catch-up']),

  e('dd-next',
    ['When is the next Dev Discussion?', 'whats the next session', 'upcoming dev discussion',
     'when is the next one', 'next meeting', 'schedule'],
    "I do not have the current schedule offline, and I would rather not guess at a date you might turn up for.\n\nAsk anyone at the stand — they will know what is coming up — or email codingclub2024@aurak.ac.ae. Upcoming sessions are also announced in the weekly Tech Talk.",
    [SRC.dd], ['dev-discussions', 'schedule', 'unknown']),
];

// ================================================================
// 2. TECH TITANS — ~15%.
// ================================================================
const techTitans = [
  e('titans-what',
    ['What are Tech Titans?', 'tech titan', 'whats the leaderboard', 'explain tech titans',
     'techtitans', 'points system'],
    "Tech Titans is our semesterly leaderboard, set up to reward getting involved. Everyone starts on 1 point and climbs by activating multipliers — you enter the leaderboard the moment you earn your first one.\n\nAt the end of each semester the top three receive Coding Club Tech Titan certificates.",
    [SRC.titans], ['tech-titans', 'leaderboard']),

  e('titans-multipliers',
    ['How do the multipliers work?', 'how do i earn points', 'what are the multiplier values',
     'how does scoring work', 'point values', 'how do i score'],
    "Everything multiplies rather than adds. Voting on a Tech Talk poll is x2. Attending a Dev Discussion, getting featured in the meme competition, volunteering, or shipping a major update to a project you already submitted are each x4. Winning a typeathon or a Mentimeter question, or taking part in an official competition, is x8.\n\nThe big ones are x16 for showcasing a project at a Dev Discussion, and x32 for placing in a competition or winning best project of the semester.",
    [SRC.titans], ['tech-titans', 'multipliers', 'scoring']),

  e('titans-big',
    ['Why are the scores so big?', 'how did someone get billions of points',
     'the numbers look fake', 'biggest score', 'highest score ever'],
    "Because the multipliers compound rather than adding up, scores get out of hand very quickly — which is entirely the point of a binary-themed system.\n\nOur Fall 2024 winner, Abdulghani Sabbagh, finished the semester on 590,295,810,358,705,651,712 points. That is a real number from a real leaderboard.",
    [SRC.titans], ['tech-titans', 'scores']),

  e('titans-penalties',
    ['Are there penalties?', 'can i lose points', 'what happens if i cheat',
     'negative points', 'penalty system'],
    "There are. Not meeting the responsibilities of a volunteer position halves your score, repeatedly ignoring club guidelines divides it by four, and plagiarism or cheating in a club competition divides it by eight.\n\nIn practice they almost never come up — but a leaderboard with no downside would not mean much.",
    [SRC.titans], ['tech-titans', 'penalties']),

  e('titans-start',
    ['How do I start earning points?', 'how do i get on the leaderboard',
     'how do i join tech titans', 'where do i start'],
    "Come to a Dev Discussion — that is a x4 multiplier and the easiest way onto the board. Voting on a Tech Talk poll is another easy x2.\n\nEvery member starts on 1 point by default, and you appear on the leaderboard as soon as you activate your first multiplier. There is nothing to sign up for beyond being a member.",
    [SRC.titans], ['tech-titans', 'getting-started']),

  e('titans-majorwars',
    ['What is Major Wars?', 'major wars', 'do majors compete', 'which major is winning'],
    "Major Wars is the side competition that runs alongside the individual leaderboard — everyone's points are also totalled up by academic major.\n\nArtificial Intelligence took it in Spring 2024, then Computer Engineering won both Summer and Fall 2024. It is a good-natured rivalry and a reason to drag your coursemates along.",
    [SRC.titans], ['tech-titans', 'major-wars']),

  e('titans-standings',
    ['Who is winning right now?', 'current standings', 'this semester leaderboard',
     'where am i on the leaderboard', 'my score'],
    "I do not have the current semester's standings offline, so I cannot tell you who is ahead right now — and I would rather not guess at something as competitive as a leaderboard position.\n\nAsk a crew member at the stand, or email codingclub2024@aurak.ac.ae and we can tell you exactly where you stand and what would move you up.",
    [SRC.titans], ['tech-titans', 'standings', 'unknown']),
];

// ================================================================
// 3. JOINING & BELONGING — ~15%.
// ================================================================
const joining = [
  e('join-how',
    ['How do I join?', 'how can i become a member', 'i want to join', 'sign me up',
     'how do i sign up', 'membership'],
    "Come and talk to us at the stand — we can get you signed up on the spot, and someone will walk you through what is coming up this semester.\n\nMembership is open to every AURAK student, from any major and any skill level. There is no application to pass and no experience required.",
    [SRC.joining, SRC.faq], ['joining', 'membership']),

  e('join-nocode',
    ['Do I need to know how to code?', 'i cant code', 'is it only for programmers',
     'i have no experience', 'do i need experience', 'im not technical'],
    "Not at all. The club is explicitly for complete beginners as well as experienced programmers, and plenty of our members joined knowing nothing.\n\nOur leaderboard has included students from Mass Communication, Business, Architecture, Biotechnology and several engineering disciplines — not just computing majors. If you are curious, you already qualify.",
    [SRC.about, SRC.faq], ['joining', 'beginners', 'majors']),

  e('join-major',
    ['Can I join if I am not a CS major?', 'im not a computer science student',
     'is it only for cs students', 'what majors can join', 'im an engineering student',
     'non cs'],
    "Yes. Members come from right across the university — Artificial Intelligence, Computer Science, Computer Engineering, Electrical, Mechanical, Civil and Chemical Engineering, Mass Communication, Biotechnology, Architecture and Business have all been represented on our leaderboard.\n\nYou do not have to be a computing major to join, and you will not be the only non-specialist in the room.",
    [SRC.about], ['joining', 'majors']),

  e('join-crew',
    ['What is the crew?', 'how do i join the crew', 'can i help run the club',
     'crew vs member', 'leadership roles', 'become an organiser'],
    "The crew is the team that runs the club rather than only attending it — President, Vice President, Technical Lead, Event Manager, Executive, Social Media Manager, Graphic Designer and Photographer.\n\nWe are currently recruiting for Social Media Manager, Graphic Designer and Photographer/Videographer. If any of those sound like you, talk to a crew member at the stand.",
    [SRC.crew, SRC.joining], ['joining', 'crew', 'recruiting']),

  e('join-time',
    ['How much time does it take?', 'is it a big commitment', 'time commitment',
     'im busy', 'how often do you meet', 'will it affect my studies'],
    "As much or as little as you want. Dev Discussions are the main fixture and each is about an hour; plenty of members come to those and nothing else.\n\nThere is no attendance requirement and nothing you have to keep up with. The Tech Titans leaderboard rewards turning up, but never punishes you for not.",
    [SRC.dd, SRC.titans], ['joining', 'commitment']),

  e('join-cost',
    ['Does it cost anything?', 'is there a fee', 'do i have to pay', 'membership fee', 'free'],
    "There is nothing to pay to be a member — we are a student club, and everything we run is free to attend.\n\nCome to a Dev Discussion, read the Tech Talk, take part in the leaderboard: none of it costs anything.",
    [SRC.joining], ['joining', 'cost']),
];

// ================================================================
// 4. OTHER PROGRAMMES — ~20%.
// ================================================================
const programmes = [
  e('prog-techtalk',
    ['What is Tech Talk?', 'tell me about tech talks', 'the newsletter', 'techtalk',
     'what is the magazine'],
    "Tech Talk is our weekly newsletter, published as a magazine — news, announcements, member projects, polls and programming memes, laid out like a newspaper front page.\n\nVoting on its polls is worth a x2 multiplier on the leaderboard, and it is where we announce what is coming up.",
    [SRC.projects, SRC.faq], ['tech-talk', 'newsletter']),

  e('prog-techtalk-write',
    ['Can I write for Tech Talk?', 'how do i get featured', 'can i contribute an article',
     'peer2peer', 'submit writing'],
    "Yes — there is a recurring column called Peer2Peer that carries member writing, and we are always looking for pieces.\n\nWrite about any topic that inspires you, tech-related or otherwise, and email it to codingclub2024@aurak.ac.ae. Getting featured also puts you on the leaderboard.",
    [SRC.projects], ['tech-talk', 'contributing']),

  e('prog-review',
    ['What is Review Rounds?', 'review rounds', 'exam help', 'do you help with exams',
     'midterm revision', 'study help'],
    "Review Rounds are review videos we post to our YouTube channel to help AURAK students prepare for midterms and finals.\n\nThey were set up in Spring 2024 and we have posted them most semesters since — a straightforward way the club tries to be useful during exam season.",
    [SRC.about, SRC.faq], ['review-rounds', 'exams']),

  e('prog-typeathon',
    ['What is a typeathon?', 'typeathon', 'typing competition', 'typathon'],
    "A timed typing contest. We usually run one at the end of a Dev Discussion — it takes about ten minutes and is a good way to close a session.\n\nWinning one is worth a x8 multiplier on the Tech Titans leaderboard.",
    [SRC.about, SRC.titans], ['typeathon', 'competitions']),

  e('prog-competitions',
    ['Do you run coding competitions?', 'competitions', 'contests', 'hackathon',
     'programming contest'],
    "We do — official Coding Club competitions alongside the lighter typeathons and meme competitions.\n\nTaking part is worth a x8 multiplier on the leaderboard, and placing first, second or third is worth x32. They are among the biggest scoring opportunities of the semester.",
    [SRC.about, SRC.titans], ['competitions']),

  e('prog-trips',
    ['Do you go on trips?', 'field trips', 'wetex', 'do you visit conferences',
     'events outside campus'],
    "Yes. We organise visits to conferences and technology events off campus — most recently a trip to WETEX 2024, one of the largest technology exhibitions in the region.\n\nThey are a chance to see the industry side of things, meet people well beyond the university, and spend a day with other members outside a lab.",
    [SRC.about, SRC.history], ['trips', 'events']),

  e('prog-collabs',
    ['Do you work with other clubs?', 'collaborations', 'other societies', 'joint events'],
    "Often. We have run joint events with the Gaming Club and the Volunteering Club on a Rubik's Cube event, with the Music Club on the Experience the Sound of Code session, and with the Book Club on Books & Bytes, a tech-themed summer reading list and discussion.\n\nCross-club events tend to be some of the most fun things we do.",
    [SRC.about, SRC.history], ['collaborations']),

  e('prog-commends',
    ['What is Coding Club Commends?', 'resource recommendations', 'book recommendations',
     'what should i read', 'learning resources', 'commends'],
    "Commends is our collection of recommended resources — books, courses, websites and tools — with a short write-up of each and commentary from members who have used them.\n\nIt covers programming, compilers, data structures and algorithms, mathematics, theory of computation and systems. Anyone can contribute by opening a pull request on our GitHub.",
    [SRC.projects], ['commends', 'resources', 'books']),
];

// ================================================================
// 5. ABOUT THE CLUB — ~15%.
// ================================================================
const about = [
  e('about-what',
    ['What is the Coding Club?', 'tell me about the club', 'what do you do', 'who are you',
     'what is this club', 'about'],
    "We are the student coding and technology club at the American University of Ras Al Khaimah — a community for anyone interested in code, from complete beginners to people who have been programming for years.\n\nOur flagship activity is Dev Discussions, deep dives into a computer science topic held in G-201. Alongside that we publish the weekly Tech Talk newsletter, post Review Rounds exam-prep videos, and run competitions, typeathons and trips to tech events.",
    [SRC.about, SRC.dd], ['about', 'overview']),

  e('about-awards',
    ['Have you won anything?', 'awards', 'most active club', 'achievements',
     'is the club any good', 'recognition'],
    "We have won AURAK's Most Active Student Club Award twice — for Spring 2024 and again for Fall 2024.\n\nThat second one came off the back of a busy semester: the club fair, a trip to WETEX, the freshman orientation event, and collaborations with three other clubs.",
    [SRC.history, SRC.faq], ['about', 'awards']),

  e('about-who',
    ['Who runs the club?', 'who is the president', 'the crew', 'committee', 'leadership',
     'who is in charge'],
    "The club is run by a student crew. Riyad Almasri is President and Ahmed Fadhl is Vice President, with Mukerem Shifa as Technical Lead, Hewan Gete as Event Manager and Hussain Para as Executive.\n\nWe are currently recruiting a Social Media Manager, a Graphic Designer and a Photographer/Videographer.",
    [SRC.crew], ['about', 'crew']),

  e('about-contact',
    ['How do I contact you?', 'email', 'whats your email', 'get in touch', 'contact',
     'reach you'],
    "Email us at codingclub2024@aurak.ac.ae — that reaches the crew and is the best route for anything that needs a real answer.\n\nYou can also find all our work on GitHub at github.com/AURAK-Coding-Club, and of course you can just talk to whoever is at the stand.",
    [SRC.joining, SRC.faq], ['contact', 'email']),

  e('about-github',
    ['Are you on GitHub?', 'github', 'where is your code', 'repositories', 'open source'],
    "Everything we do is public at github.com/AURAK-Coding-Club — the Tech Talk issues, the Dev Discussions agendas and slides, the Commends resource collection, our slide-deck template, and a verifiable credentials system we built for issuing club certificates.\n\nContributions are welcome; several of those repositories take pull requests from members.",
    [SRC.projects], ['github', 'projects']),

  e('about-history',
    ['How long has the club been around?', 'club history', 'when was it founded',
     'how old is the club', 'history'],
    "The club has been running for several years, but Spring 2024 was when it was substantially rebuilt — new branding, a new management team, faculty sponsors, and the launch of Tech Talks, Dev Discussions and Review Rounds all in one semester.\n\nThat semester won us our first Most Active Student Club Award, and we won it again in Fall 2024.",
    [SRC.history], ['about', 'history']),

  e('about-conduct',
    ['What are the club rules?', 'code of conduct', 'is it welcoming', 'inclusive',
     'what if someone is rude', 'rules'],
    "We hold to respect, inclusivity, collaboration, professionalism, integrity, safety, diversity and responsibility — and we mean the first one in particular. Members are expected to treat each other well regardless of background, identity or skill level.\n\nAnything that falls short of that is dealt with by the crew. We also follow AURAK's own rules and the cultural values of the UAE.",
    [SRC.about], ['conduct', 'rules']),
];

// ================================================================
// 6. CONVERSATIONAL GLUE — ~10%.
// ================================================================
const glue = [
  e('glue-hi',
    ['hi', 'hello', 'hey', 'yo', 'hi there', 'good morning', 'salam', 'hey there'],
    "Hello. I am the AURAK Coding Club's assistant — ask me anything about what we run, how to join, or how the Tech Titans leaderboard works.\n\nIf you would rather talk to a person, there is one standing right next to this screen.",
    [], ['greeting']),

  e('glue-can',
    ['What can you do?', 'what can i ask', 'help', 'what do you know', 'options',
     'what should i ask you'],
    "I can tell you about Dev Discussions — our flagship sessions — the Tech Titans leaderboard, how to join, and the other things we run: Tech Talk, Review Rounds, competitions and trips.\n\nTry asking what a Dev Discussion is, or whether you need to know how to code to join.",
    [], ['help', 'meta']),

  e('glue-more',
    ['tell me more', 'more', 'go on', 'and', 'what else', 'anything else'],
    "Happy to — though I answer each question on its own here, so tell me which part you would like to hear more about and I will go deeper on it.\n\nDev Discussions and what happens in a session, the Tech Titans leaderboard, how to join, Tech Talk, or the competitions and trips we run: pick one and ask away.",
    [], ['meta']),

  e('glue-who-built',
    ['Who built this?', 'who made you', 'who made this page', 'is this custom',
     'who wrote this', 'how was this built'],
    "This terminal and the assistant behind it were built by Mukerem Shifa, one of our club members.\n\nIt is running against a real retrieval pipeline over the club's own documents — the sources listed under each answer are the actual documents the reply came from.",
    [], ['meta', 'about']),

  e('glue-ai',
    ['Are you an AI?', 'are you a bot', 'are you real', 'are you chatgpt', 'is this ai'],
    "I am, yes — an assistant answering from the club's own documents rather than from general knowledge, which is why I cite where each answer came from.\n\nIt also means I will tell you when I do not know something rather than making it up.",
    [], ['meta']),

  e('glue-thanks',
    ['thanks', 'thank you', 'cheers', 'ty', 'thx', 'appreciate it'],
    "Any time. If you want to take it further, come along to a Dev Discussion — an hour in G-201 on one topic, and honestly where the club is at its best.\n\nAnd do say hello to whoever is standing at the stand; they can sign you up in about a minute.",
    [], ['meta']),
];

// ================================================================
// Assembly
// ================================================================
const entries = [...devDiscussions, ...techTitans, ...joining, ...programmes, ...about, ...glue];

// ---------------------------------------------------------------
// Validation. Each of these has a matching constraint in the brief,
// and each is a way the file can look fine and behave badly:
// duplicate ids break dedup, a fabricated citation renders a source
// that does not exist, an overlong answer scrolls off the CRT, and a
// `×` renders in a fallback face mid-sentence.
// ---------------------------------------------------------------
const problems = [];

const realTitles = new Set(Object.values(SRC));
const seenIds = new Set();
const seenQuestions = new Map();

for (const entry of entries) {
  if (seenIds.has(entry.id)) problems.push(`duplicate id: ${entry.id}`);
  seenIds.add(entry.id);

  if (entry.questions.length < 4) {
    problems.push(`${entry.id}: only ${entry.questions.length} phrasings (brief asks 4-8)`);
  }
  if (entry.questions.length > 8) {
    problems.push(`${entry.id}: ${entry.questions.length} phrasings exceeds 8`);
  }

  for (const q of entry.questions) {
    const norm = q.trim().toLowerCase();
    // A phrasing appearing in two entries makes matching non-deterministic:
    // whichever the scorer happens to reach first wins.
    if (seenQuestions.has(norm)) {
      problems.push(`phrasing "${q}" is in both ${seenQuestions.get(norm)} and ${entry.id}`);
    }
    seenQuestions.set(norm, entry.id);
  }

  const words = entry.answer.split(/\s+/).length;
  if (words < 40) problems.push(`${entry.id}: answer is ${words} words (min 40)`);
  if (words > 120) problems.push(`${entry.id}: answer is ${words} words (max 120)`);

  if (entry.answer !== entry.answer.trim()) problems.push(`${entry.id}: answer has edge whitespace`);
  if (/^#|^[-*] |^\d+\. /m.test(entry.answer)) problems.push(`${entry.id}: answer contains markdown`);
  if (entry.answer.includes('×')) problems.push(`${entry.id}: uses × — the CRT font lacks the glyph, use x`);
  if (/https?:\/\/forms\.gle/.test(entry.answer)) problems.push(`${entry.id}: contains a signup form URL`);

  for (const c of entry.citations) {
    if (!realTitles.has(c)) problems.push(`${entry.id}: citation "${c}" is not a real source title`);
  }
  if (new Set(entry.citations).size !== entry.citations.length) {
    problems.push(`${entry.id}: duplicate citations`);
  }
}

if (entries.length < 40 || entries.length > 80) {
  problems.push(`${entries.length} entries is outside the 40-80 the brief asks for`);
}

// The file-backed titles must still exist in the corpus. A renamed
// heading upstream would otherwise ship citations naming documents the
// live bot no longer has.
let corpusTitles = null;
try {
  const mod = await import('../config/coding-club-bot.js');
  corpusTitles = new Set(mod.clubSources().map((s) => s.title));
  for (const key of FILE_BACKED) {
    if (!corpusTitles.has(SRC[key])) {
      problems.push(`SRC.${key} "${SRC[key]}" no longer matches any corpus document title`);
    }
  }
} catch (err) {
  problems.push(`could not read the corpus to verify titles: ${err.message}`);
}

if (problems.length) {
  console.error('\nRefusing to write — the cache would ship broken:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------
// Write
// ---------------------------------------------------------------
let sha = 'unknown';
try {
  sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch { /* not a git checkout; `unknown` is honest */ }

const greeting = (() => {
  // Taken from the bot's own widget_config so the offline greeting and
  // the live one cannot drift apart.
  const raw = readFileSync(join(ROOT, 'config', 'coding-club-bot.js'), 'utf8');
  const m = /greeting:\s*\n?\s*'([^']+)'\s*\+\s*\n\s*'([^']+)'/.exec(raw);
  return m ? (m[1] + m[2]).trim() : 'Ask me anything about the AURAK Coding Club.';
})();

const cache = {
  // Local date, not UTC: `toISOString` is UTC and stamps yesterday's
  // date for anyone west of the meridian in the evening, which makes a
  // freshly built cache look stale next to the corpus sha beside it.
  version: new Date().toLocaleDateString('en-CA'),
  source: `docs/coding-club @ ${sha}`,
  greeting,
  suggestions: [
    'What is a Dev Discussion?',
    'How do I join?',
    'What are Tech Titans?',
    'Do I need to know how to code?',
  ],
  entries,
};

const json = JSON.stringify(cache, null, 2);
writeFileSync(OUT, json, 'utf8');

const kb = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
const phrasings = entries.reduce((n, x) => n + x.questions.length, 0);

console.log(`
  wrote ${OUT}
  ${entries.length} entries, ${phrasings} question phrasings
  ${kb} KB  (brief allows 400 KB, targets 150-250 KB)
  source ${cache.source}
`);

if (Number(kb) > 400) {
  console.error('  OVER the 400 KB ceiling — trim before shipping.\n');
  process.exit(1);
}
