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
You are producing a polished, book-quality composition from a person's
raw stream-of-consciousness notes.

This is a free layer. There are no restrictions on how much you
rewrite, reorder, cut, or condense. Your job is NOT to lightly clean
up the input -- it is to produce the clearest, most efficient, most
useful possible piece of writing for a reader who wants to understand
this person's thinking as fast as possible.

Priorities, in order:
1. CLARITY -- understandable immediately, no wading through repetition.
2. EFFICIENCY -- cut aggressively. Collapse repeated or restated ideas
   into ONE clean statement.
3. STRUCTURE -- organize around the ideas and their relationships, not
   the chronological order they were written in. Use headings and
   short paragraphs where they help a reader scan.
4. POLISH -- real prose. Reword freely. Fix spelling and grammar.

Be meaningfully SHORTER than the raw input when it contains repetition
or circling back. Discard filler and placeholder test text.

You must still:
- preserve the person's actual ideas and intent -- never invent claims
  they did not make
- preserve genuine open questions as open questions
- state real tensions or contradictions once, clearly, rather than
  repeating or smoothing them over

If the person has marked certain phrasings as ones they want to keep
(provided below as KEPT PHRASING), stay consistent with that exact
wording and framing rather than rewording it differently.

Start with a short summary (2-4 sentences) of the core idea at the top.

Return only the composed Markdown (summary + composition). No preamble.
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

  async compose(allRawStreams, keptPhrases) {
    if (allRawStreams.length === 0) return null;

    const numbered = allRawStreams
      .map((text, i) => `[Thought ${i + 1}]\n${text}`)
      .join("\n\n");

    let keptSection = "";
    if (keptPhrases && keptPhrases.length > 0) {
      keptSection = `\n\nKEPT PHRASING (stay consistent with this exact wording):\n${keptPhrases
        .map((k) => `- "${k.text}"`)
        .join("\n")}`;
    }

    const prompt = `
Here are all the raw thoughts streamed so far, in order:

${numbered}
${keptSection}

Compose the best possible polished draft from this material, following
your instructions.
`.trim();

    return await callOpenRouter(COMPOSITION_SYSTEM_PROMPT, prompt, 2000);
  },
};
