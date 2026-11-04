// The setup sections: what each one holds, how material gets in, and the
// prompt a team can run in their own AI tool to produce it in our format.

import type { DocKind } from "./types";

export type InputMethod = "paste" | "upload" | "url";

/** What the add-material box says for one section, so it never looks the same everywhere. */
export interface MaterialCopy {
  title: string;
  intro: string;
  nameExample: string;
  textPlaceholder: string;
  uploadHelp: string;
  linksHelp: string;
}

export interface DocSection {
  kind: DocKind;
  path: string;
  title: string;
  purpose: string;
  required: boolean;
  methods: InputMethod[];
  prompt: string;
  emptyHint: string;
  material: MaterialCopy;
}

const OUTPUT_RULES = `OUTPUT RULES
- Write in plain Markdown with short headings and bullet points.
- Use only what my material says. Do not invent details.
- Where something is missing, list it under an "Open questions" heading at the end instead of guessing.
- Start with the document itself: no introduction and no closing summary.`;

export const DOC_SECTIONS: DocSection[] = [
  {
    kind: "icp",
    path: "icp",
    title: "Ideal customer profile",
    purpose: "Who you write for. Every piece is planned against this.",
    required: true,
    methods: ["paste", "upload"],
    emptyHint: "Paste your ICP doc, persona notes or sales playbook, or upload the file.",
    material: {
      title: "Add what you know about your customers",
      intro: "An ICP doc, persona notes, a sales playbook or call-prep notes. Add as many as you have; AI merges them into one profile.",
      nameExample: "Sales playbook 2026",
      textPlaceholder: "Paste your ICP doc, persona notes or sales playbook",
      uploadHelp: "ICP docs, persona decks, playbooks.",
      linksHelp: "Public pages about your customers, such as a persona page or a case-study index.",
    },
    prompt: `TASK
Using the documents and notes I've shared with you, write our ideal customer profile.

STEPS
1. Read everything I've shared.
2. Write one section for each of these headings:
   - Who we sell to: roles, company types and sizes, industries
   - What they're responsible for
   - Problems and pressures they face
   - What they've already tried
   - How they judge a solution
   - Questions they search for
   - The exact words they use to describe their problems
3. Under each heading, write short bullet points taken from my material.

${OUTPUT_RULES}`,
  },
  {
    kind: "positioning",
    path: "positioning",
    title: "Positioning",
    purpose: "What you stand for against the alternatives.",
    required: true,
    methods: ["paste", "upload"],
    emptyHint: "Paste your positioning or messaging doc, or upload it.",
    material: {
      title: "Add your positioning and messaging",
      intro: "A positioning doc, messaging framework, competitor comparison or the text of a pitch deck.",
      nameExample: "Messaging framework",
      textPlaceholder: "Paste your positioning or messaging doc",
      uploadHelp: "Positioning docs, messaging frameworks, pitch-deck text.",
      linksHelp: "Your own pages that state your positioning, such as your home or about page.",
    },
    prompt: `TASK
Using the documents and notes I've shared with you, write our positioning.

STEPS
1. Read everything I've shared.
2. Write one section for each of these headings:
   - The category we compete in
   - Who it's for
   - The main alternatives buyers consider (including doing nothing)
   - What we do differently
   - The evidence behind each difference
   - Claims we make, and claims we deliberately don't make
3. Under each heading, write short bullet points taken from my material.

${OUTPUT_RULES}`,
  },
  {
    kind: "strategy_notes",
    path: "strategy-notes",
    title: "Other strategy notes",
    purpose: "Optional. Content pillars, goals, topics to avoid.",
    required: false,
    methods: ["paste", "upload"],
    emptyHint: "Optional: paste content pillars, goals or a topics-to-avoid list.",
    material: {
      title: "Add your content strategy notes",
      intro: "Content pillars, goals, and any list of topics to avoid. Optional, and short is fine.",
      nameExample: "Content pillars",
      textPlaceholder: "Paste content pillars, goals or a topics-to-avoid list",
      uploadHelp: "Strategy docs, editorial calendars' notes.",
      linksHelp: "A public content strategy or editorial-guidelines page.",
    },
    prompt: `TASK
From what I've shared, summarise how we decide what to write about.

STEPS
1. Read everything I've shared.
2. Write one short section for each of these headings:
   - Content pillars or themes
   - What our content is meant to achieve
   - Topics we avoid, and why
3. Keep the whole document under one page.

${OUTPUT_RULES}`,
  },
  {
    kind: "core_voice",
    path: "voice",
    title: "Core voice",
    purpose: "How you sound in every format: viewpoint, vocabulary, rules.",
    required: true,
    methods: ["paste", "upload"],
    emptyHint: "Paste your style guide or brand voice doc, or the instructions from your Claude Project, skill or Custom GPT.",
    material: {
      title: "Add your style guide and voice rules",
      intro: "A style guide, brand voice doc, or the instructions from your Claude Project, skill or Custom GPT. Leave out format habits like length; those go on each format.",
      nameExample: "Brand voice guide",
      textPlaceholder: "Paste your style guide, or the instructions you give your AI tool",
      uploadHelp: "Style guides and brand voice docs.",
      linksHelp: "A public style or brand-voice page.",
    },
    prompt: `TASK
Using our style guide, brand docs and any writing instructions I've shared (including instructions from
Claude Projects, skills or Custom GPTs), write our core writing voice.

STEPS
1. Read everything I've shared.
2. Write one section for each of these headings:
   - The viewpoint and philosophy behind our writing
   - How we sound
   - Words and phrases we use
   - Words and phrases we avoid, including generic AI phrasing we never want, such as "delve",
     "in today's fast-paced world" or "it's not just X, it's Y"
   - How bold or careful we are with claims
   - How we treat the reader
   - Do and don't rules, each with a short example
3. Leave out format-specific habits such as length, structure and hooks. Those live in each format's
   style profile.

${OUTPUT_RULES}`,
  },
];

export const FORMAT_TEMPLATES: { key: string; name: string; description: string }[] = [
  { key: "tl_blog", name: "Thought leadership blog", description: "Opinionated long-form essay under a named author." },
  { key: "tl_linkedin", name: "Thought leadership LinkedIn post", description: "A personal, opinionated post from a named author." },
  { key: "longform_blog", name: "Long-form blog", description: "Educational or search-led article." },
  { key: "promo_social", name: "Promotional social", description: "Launches, offers and posts with a call to action." },
  { key: "short_social", name: "Short-form social", description: "Everyday posts: quick insights and takes." },
  { key: "case_study", name: "Case study", description: "A customer story with a problem, approach and result." },
  { key: "instagram_caption", name: "Instagram caption", description: "A caption that lands one point and invites a response." },
  { key: "instagram_carousel", name: "Instagram carousel", description: "Slides that build one idea; each slide is a section." },
  { key: "linkedin_carousel", name: "LinkedIn carousel", description: "A document post: slides that teach or argue one thing." },
  { key: "x_thread", name: "X thread", description: "A thread of short posts; each post is a section." },
  { key: "short_video_script", name: "Short video script", description: "Reels, Shorts or TikTok: hook, point, proof, call to action." },
  { key: "video_script", name: "Video script", description: "A spoken script in segments, written for the ear." },
  { key: "newsletter", name: "Newsletter", description: "A short issue with a few sections and links back to sources." },
  { key: "webinar_outline", name: "Webinar or talk outline", description: "Talking points for a live session, segment by segment." },
];

export const FORMAT_PROMPT = (formatName: string) =>
  `TASK
I'm going to share examples of our best "${formatName}" pieces. Describe what they have in common so a
writer can match the style.

STEPS
1. Read every example.
2. Write one section for each of these headings:
   - How they open (quote one or two real openings)
   - How they're structured
   - Sentence and paragraph rhythm
   - How personal they are
   - Use of headings, lists, data and quotes
   - How they end, and how they handle calls to action
   - Typical length (report it as an observation, not a target)
3. Describe only habits that are specific to this format, not our general brand voice.

${OUTPUT_RULES}`;

export const INSIGHT_PROMPT = `TASK
Read the transcript below and pull out the key insights only our company could say.

STEPS
1. Read the whole transcript.
2. Find statements, stories, numbers and opinions that only this company could say.
3. Test each one: could a competitor write this sentence? If yes, leave it out.
4. Skip pleasantries, generic industry statements and product pitch lines.
5. Write one item for each insight that passes. Strongest first. At most 15.

FIELDS (every item has exactly these fields)
- "type": one of "story", "opinion", "data_point", "technical_detail", "customer_quote", "lesson"
- "claim": ONE plain sentence stating the insight
- "detail": 2 to 5 sentences with the specifics, so it stands alone. Do not start by repeating the claim.
  For a customer_quote, put the speaker's exact words here.
- "source_who", "source_where", "source_date": who said it, where, when ("" if unknown)
- "citation": "public" only if it can be quoted and attributed; otherwise "internal"
- "tags": 2 to 5 short lowercase topic tags
- "value", "unit", "period", "sample_size": for data points; "" otherwise

OUTPUT FORMAT
Return only a JSON array, with no other text. If nothing passes the test, return [].
Write the whole array on a single line, so it fits in one spreadsheet cell and a column of answers can
be imported as one JSON array per row.

Transcript:
[paste transcript here]`;

export const DATA_PROMPT = `TASK
From the reports, dashboards or documents I've shared, list the figures our company has measured itself.

STEPS
1. Read everything I've shared.
2. Pick out figures our company measured itself. Do not include industry statistics from elsewhere.
3. Skip any figure whose source or time period you can't tell from the material.
4. Write one item for each figure.

FIELDS (every item has exactly these fields)
- "type": "data_point"
- "claim": one sentence stating what the figure shows
- "value": the number as written, e.g. "18%" or "4.2"
- "unit", "period", "sample_size": e.g. "%", "Q1 2026", "212 customers" ("" if unknown)
- "detail": how it was measured and any caveats
- "source_who", "source_where", "source_date": who measured it, which report, when
- "citation": "public" if we've published it or may; otherwise "internal"
- "tags": 2 to 5 short lowercase topic tags

OUTPUT FORMAT
Return only a JSON array, with no other text.`;

/** What the add-material box says on a format's page. */
export const formatMaterial = (formatName: string): MaterialCopy => ({
  title: `Add your best ${formatName} examples`,
  intro: "Two to five pieces you consider perfect. Paste their links in bulk, or paste the text. AI works out what they have in common, and you review every line.",
  nameExample: `Example ${formatName}, March launch`,
  textPlaceholder: "Paste one complete example piece",
  uploadHelp: "Finished pieces saved as files.",
  linksHelp: "Paste the most relevant links, one per line. LinkedIn, X and similar sites block fetching: paste those posts as text instead.",
});

/** For the writing stage: the writer runs it in their own AI tool, then pastes the result back. */
export const HUMANIZER_PROMPT = `TASK
Edit the text below so it reads like a person wrote it, without changing what it says.

STEPS
1. Read the whole text first.
2. Find the places that sound machine-written (see the list below).
3. Rewrite only those places. Leave sentences that already sound natural exactly as they are.
4. Check that every fact, number, name, date and quote is unchanged.

WHAT TO FIX
- Filler openers and transitions: "In today's fast-paced world", "It's important to note", "Moreover", "Furthermore", "In conclusion".
- The "it's not just X, it's Y" pattern, and other balanced, formula-like sentences.
- Stock words: delve, leverage, unlock, elevate, robust, seamless, landscape, tapestry, game-changer.
- Lists of exactly three adjectives or examples used as padding.
- Sentences that all have the same length and rhythm. Mix short and long ones.
- Vague claims. Replace them with the specific detail already in the text. Do not invent new detail.
- Too many em dashes, colons and rhetorical questions.

RULES
- Keep the writer's meaning, argument, order and point of view.
- Do not add facts, examples, numbers or names. Do not remove any.
- Keep the same length, give or take 10%.
- Use plain words. Prefer concrete nouns and active verbs.
- If a sentence is already fine, do not touch it.

OUTPUT FORMAT
Return only the edited text, with no introduction, no notes and no list of changes.`;

/** For the writing stage: restyle a finished text to sound like one leader. Run in the writer's own AI tool. */
export function writeLikePrompt(voice: { name: string; role: string; profile: string }): string {
  const who = voice.role.trim() ? `${voice.name} (${voice.role.trim()})` : voice.name;
  return `TASK
Edit the text below so it sounds like ${who} wrote it, without changing what it says.

HOW ${voice.name.toUpperCase()} WRITES
${voice.profile.trim()}

STEPS
1. Read the whole text first.
2. Read the description above of how ${voice.name} writes.
3. Rework the wording, sentence length, rhythm and openings so they match that description.
4. Check that every fact, number, name, date and quote is unchanged.

RULES
- Keep the meaning, argument, order and facts exactly as they are.
- Do not add facts, examples, numbers, names or opinions. Do not remove any.
- Do not copy phrases from the description word for word unless they fit naturally.
- Keep the same length, give or take 15%.
- Keep headings and any [1], [2] style references where they are.
- If a sentence already sounds like ${voice.name}, leave it alone.

OUTPUT FORMAT
Return only the edited text, with no introduction, no notes and no list of changes.`;
}

/** For the Leader voices page: build a voice description from a person's real writing, in the editor's own AI tool. */
export const LEADER_VOICE_PROMPT = `TASK
Describe how the person whose writing I paste below writes, so that another writer could imitate them.

STEPS
1. Read all the samples first.
2. Note what is consistent across them: how they open, how long their sentences and paragraphs are, which words they favour or avoid, how formal they are, how they use numbers, examples and humour, and how they close.
3. Write the description as a short list of concrete rules.

RULES
- Use 8 to 15 rules. Each is one line, written as an instruction (for example: "Opens with the claim, never with context").
- Only describe patterns you can see in at least two samples.
- Quote a short example phrase from the samples after a rule when it helps, in quotation marks.
- Do not describe the topics they write about. Describe how they write.
- Do not flatter. No words like "engaging" or "compelling".

OUTPUT FORMAT
Return only the list of rules, one per line, starting each with a dash. No introduction.

THE SAMPLES
(paste 3 to 5 pieces of their real writing here)`;

export const VOICE_MEMORY_PROMPT =`TASK
From our past conversations and any writing of mine you can see, list the writing preferences I have shown
or told you about, as short rules I can reuse on any piece.

STEPS
1. Look for things I corrected, cut, rewrote or asked you to avoid or always do.
2. Turn each pattern into one rule.
3. Keep only rules that are specific, behavioural and reusable across topics.
4. Skip anything about a single topic, and anything vague such as "be engaging".

GOOD RULES
- Open with the claim, not the context.
- Never use the word "leverage".
- Write numbers as digits.

OUTPUT FORMAT
A plain list with one rule per line and nothing else: no headings, no introduction, no numbering,
no explanations. At most 20 rules, strongest first. If you can't find any, say so in one line.`;
