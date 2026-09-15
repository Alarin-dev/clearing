/*
  The only file that talks to an AI model. Mirrors classifier.py and
  compose.py's prompts and constraints exactly, just as fetch() calls
  instead of the openai Python client.

  The API key is the user's own, stored only in their browser's
  localStorage, sent only to OpenRouter. It never touches any server
  of ours, because there is no server -- this is a static site.
*/

const CLASSIFIER_SYSTEM_PROMPT = `
You are a filing decision-maker for a personal thinking tool.

You do not see or produce the document's prose. Your only job is to
decide which section a new raw thought belongs to.

Rules:
- You must NOT reproduce, rewrite, paraphrase, or summarize the thought
  itself anywhere in your response.
- Prefer an existing section if the thought reasonably fits it. A
  thought "fitting" an existing section means it shares the same
  NATURE (e.g. both are open questions, or both are settled decisions)
  -- not merely that it's about the same general topic. A decision and
  a question about the same topic belong in different sections.
- Only propose a new section if the thought clearly does not fit any
  existing section.
- Section names should be short (2-4 words) and describe the nature of
  the thought, matching the naming style already used in the document.
- Do not invent a section that is a near-duplicate of an existing one.

Return ONLY valid JSON, no markdown fences, no preamble, in this exact
shape:
{
  "section_name": "the section this belongs to",
  "is_new_section": true or false,
  "reasoning": "one short sentence explaining the decision"
}
`.trim();

const COMPOSITION_SYSTEM_PROMPT = `
You are maintaining a single, continuously evolving composition -- a
polished, book-quality piece built from a person's raw
stream-of-consciousness notes.

You will be given the CURRENT COMPOSITION (the existing draft) and one
or more NEW RAW THOUGHTS that have arrived since it was last updated.

Your job is integration, not regeneration:
- Do NOT start over or rewrite the whole piece from scratch.
- Add the new thought's core insight into the block or section it most
  belongs with. If it doesn't fit anywhere, add a new block for it.
- Refine language only where needed for accuracy, consistency, or to
  make the new material read as though it were written as part of the
  same continuous piece -- not as a separate appended note.
- Reorganize existing structure ONLY if the new thought reveals that
  the current structure genuinely no longer fits (e.g. two sections
  turn out to be the same idea). Do not reorganize for its own sake.
- Prioritize coherence, accuracy, and continuity over chronological
  order -- the new thought does not need to appear "at the end."

You must NEVER remove or silently alter:
- anything in KEPT PHRASING below -- this is material the person has
  explicitly chosen to preserve. It may be woven into a different
  sentence for flow, but its meaning and substance must survive intact
  in the output.
- the core insight of any earlier material, even while condensing or
  rewording its expression.

If AVOIDED PHRASING is given below, do not reintroduce that framing or
wording -- the person has explicitly rejected it before.

Keep the same priorities as always: clarity and efficiency over
completeness, one clean statement per idea rather than repetition,
real prose (not a bulleted transcript), genuine open questions left
open, real tensions stated once rather than smoothed over.

Return only the complete updated composition in Markdown, starting
with a short 2-4 sentence summary at the top. No preamble, no meta
commentary about what changed.
`.trim();

const REGROUND_SYSTEM_PROMPT = `
You are re-deriving a composition fully from its original raw source
material, to correct any drift that may have accumulated across many
incremental edits.

You will be given ALL RAW THOUGHTS from the session and the CURRENT
COMPOSITION (for reference only -- treat the raw thoughts as ground
truth, not the current draft).

Produce the best possible fresh composition from the raw thoughts
directly, following the same priorities as always: clarity and
efficiency over completeness, one clean statement per repeated idea,
real prose, genuine open questions left open, real tensions stated
once. Use the current composition only as a reference for structure
and tone that has worked well, not as authoritative content.

KEPT PHRASING must survive intact in the output, reworded for flow if
needed but never dropped or contradicted.

Return only the composed Markdown, starting with a short summary. No
preamble.
`.trim();


function getApiKey() {
  return localStorage.getItem("rt_api_key") || "";
}

function getModel() {
  return localStorage.getItem("rt_model") || "google/gemma-4-26b-a4b-it:free";
}

async function callOpenRouter(systemPrompt, userPrompt, maxTokens) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("No API key set. Add your OpenRouter key in Settings.");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": window.location.origin,
      "X-Title": "Reflective Thinking",
    },
    body: JSON.stringify({
      model: getModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      reasoning: { enabled: false },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    const finishReason = data.choices?.[0]?.finish_reason;
    throw new Error(
      `Model returned no content (finish_reason: ${finishReason}). ` +
      `It may have run out of tokens thinking, or isn't suited for this task.`
    );
  }

  return content.trim();
}

function stripJsonFences(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
  }
  return t;
}

const AI = {
  async classify(newThought, existingSections) {
    const sectionsText = existingSections.length
      ? existingSections.join(", ")
      : "(none yet -- this is the first thought)";

    const prompt = `
EXISTING SECTIONS IN THE DOCUMENT:
${sectionsText}

NEW RAW THOUGHT (do not reproduce or rewrite this, just decide where it goes):
---
${newThought}
---

Decide which section this belongs to. Return only the JSON described
in your instructions.
`.trim();

    const raw = await callOpenRouter(CLASSIFIER_SYSTEM_PROMPT, prompt, 300);
    const jsonText = stripJsonFences(raw);

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Classifier did not return valid JSON: ${e.message}\nRaw: ${raw}`);
    }

    if (typeof data.section_name !== "string" || typeof data.is_new_section !== "boolean") {
      throw new Error(`Classifier JSON missing required fields. Raw: ${raw}`);
    }

    return data;
  },

  /**
   * Incremental composition: integrates only the newThoughts that
   * haven't been composed yet into the existing draft. Does NOT
   * resend the full raw history -- this is the fix for both recency
   * bias and cost-scaling-with-session-length.
   */
  async composeIncremental(currentComposition, newThoughts, keptPhrases, avoidedPhrases) {
    if (newThoughts.length === 0) return currentComposition;

    const newThoughtsText = newThoughts
      .map((text, i) => `[New thought ${i + 1}]\n${text}`)
      .join("\n\n");

    const keptSection = (keptPhrases && keptPhrases.length > 0)
      ? `\n\nKEPT PHRASING (must survive intact -- the person explicitly chose to keep these):\n${keptPhrases.map((k) => `- "${k.text}"`).join("\n")}`
      : "";

    const avoidedSection = (avoidedPhrases && avoidedPhrases.length > 0)
      ? `\n\nAVOIDED PHRASING (do not reintroduce this framing or wording):\n${avoidedPhrases.map((a) => `- "${a.text}"`).join("\n")}`
      : "";

    const prompt = `
CURRENT COMPOSITION:
---
${currentComposition || "(empty -- this is the first thought, so just compose an opening piece from it.)"}
---

NEW RAW THOUGHTS TO INTEGRATE:
---
${newThoughtsText}
---
${keptSection}${avoidedSection}

Integrate the new thought(s) into the current composition following
your instructions. Return the complete updated composition.
`.trim();

    return await callOpenRouter(COMPOSITION_SYSTEM_PROMPT, prompt, 2500);
  },

  /**
   * Full regeneration from raw ground truth, to correct drift that
   * may have accumulated across many incremental integrations.
   * Use occasionally, not every stream.
   */
  async regroundComposition(allRawStreams, currentComposition, keptPhrases) {
    if (allRawStreams.length === 0) return null;

    const numbered = allRawStreams
      .map((text, i) => `[Thought ${i + 1}]\n${text}`)
      .join("\n\n");

    const keptSection = (keptPhrases && keptPhrases.length > 0)
      ? `\n\nKEPT PHRASING (must survive intact):\n${keptPhrases.map((k) => `- "${k.text}"`).join("\n")}`
      : "";

    const prompt = `
ALL RAW THOUGHTS (ground truth):
---
${numbered}
---

CURRENT COMPOSITION (reference only, for structure/tone -- not authoritative content):
---
${currentComposition || "(none yet)"}
---
${keptSection}

Re-derive the best possible composition directly from the raw
thoughts, following your instructions.
`.trim();

    return await callOpenRouter(REGROUND_SYSTEM_PROMPT, prompt, 2500);
  },
};
