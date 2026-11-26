import { GoogleGenAI, Type, type GenerateContentConfig, type Part } from '@google/genai';
import mammoth from 'mammoth';
import {
  applyReplacementsToStructuredCv,
  extractDocxInfo,
  normalizeForMatch,
  sanitizeSurgicalReplacements,
  type DocxLayoutMeta,
} from './docx-template';
import { getDefaultMasterCvTemplate, MASTER_CV } from './master-cv';
import {
  CV_LIMITS,
  jobAnalysisResponseSchema,
  jobExtractionResponseSchema,
  sanitizeTailoredCV,
  sanitizeUploadedMasterCv,
  shortenReplacementsResponseSchema,
  surgicalJobAnalysisResponseSchema,
  uploadedCvParseResponseSchema,
} from './cv-schema';
import { resolveCandidateUrl } from './jina';
import type {
  ExtractedJobCandidate,
  JobExtractionResult,
  TailorableBlock,
  TailoredCV,
  TailoringDiffMap,
} from './types';

const EXTRACTION_MODELS = Array.from(
  new Set(
    [
      process.env.GEMINI_EXTRACTION_MODEL || 'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.8-flash',
    ].filter(Boolean),
  ),
);

const TAILORING_MODELS = Array.from(
  new Set(
    [
      process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.8-flash',
    ].filter(Boolean),
  ),
);

const FALLBACK_STATUS_CODES = new Set([404, 408, 429, 500, 502, 503, 504]);

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }
  return new GoogleGenAI({ apiKey });
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function isRetryableGeminiError(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status !== undefined && FALLBACK_STATUS_CODES.has(status)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /DEADLINE_EXCEEDED|UNAVAILABLE|timeout|timed out|aborted/i.test(message);
}

async function generateJsonWithFallback(
  ai: GoogleGenAI,
  prompt: string,
  config: GenerateContentConfig,
  models: string[],
  timeoutMs = 18000,
): Promise<string | undefined> {
  let lastError: unknown;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          ...config,
          httpOptions: {
            ...(config.httpOptions ?? {}),
            timeout: timeoutMs,
          },
        },
      });
      return response.text;
    } catch (error) {
      lastError = error;
      const hasNext = i < models.length - 1;
      if (hasNext && isRetryableGeminiError(error)) {
        const status = getHttpStatus(error);
        console.warn(
          `[gemini] Model ${model} failed (${status ?? 'timeout/err'}); falling back to ${models[i + 1]}`,
        );
        continue;
      }
      if (!hasNext && isRetryableGeminiError(error) && model !== 'gemini-3.5-flash-lite') {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const retryResp = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt,
            config: {
              ...config,
              httpOptions: {
                ...(config.httpOptions ?? {}),
                timeout: timeoutMs,
              },
            },
          });
          return retryResp.text;
        } catch (retryErr) {
          lastError = retryErr;
        }
      }
      throw error;
    }
  }

  throw lastError;
}

function parseJsonText(rawText: string | undefined): unknown {
  if (!rawText) {
    throw new Error('Gemini returned an empty response.');
  }
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

export async function extractMatchingJobs(
  sourceName: string,
  sourceUrl: string,
  markdown: string,
  customPrompt?: string,
): Promise<JobExtractionResult> {
  const ai = getGeminiClient();

  const prompt = [
    `You are an expert technical recruiter extracting relevant Data Analyst job listings from a company career page.`,
    `Source Name: ${sourceName}`,
    `Source URL: ${sourceUrl}`,
    customPrompt ? `User Focus Instructions: ${customPrompt}` : '',
    ``,
    `Inclusion criteria (ALL must hold):`,
    `1. Include roles matching: Data Analyst, Senior Data Analyst, Product Analyst, Senior Product Analyst, BI Analyst, Business Intelligence Analyst, Big Data Analyst, Marketing/Growth/Revenue/Risk/Fraud/Operations Data Analyst, Analytics Engineer, Data Analyst / Data Scientist hybrid roles, and Hebrew titles (דאטה אנליסט, אנליסט נתונים, אנליסט מוצר, אנליסט BI).`,
    `2. Exclude VP, Director, Head of, Team Lead / People Manager, Principal/Staff Software Engineer, pure Backend/Frontend/Fullstack/DevOps/QA Engineer, and Intern/Student roles.`,
    `3. Location must be Israel, Tel Aviv / Tel Aviv-Yafo, Central Israel, Hybrid (Israel), or Remote (eligible from Israel). Exclude roles explicitly located outside Israel (e.g., Prague, NYC, London, Berlin) unless marked Remote from Israel.`,
    `4. Each entry MUST have a specific job posting URL (resolve relative links against ${sourceUrl} if needed). Skip generic career homepages without a job ID/slug.`,
    `5. Pagination: If the page has a link to the next page of job listings (e.g., "Next", "Page 2", "?page=2"), set "nextPageUrl" to that resolved URL; otherwise set "nextPageUrl" to "".`,
    ``,
    `Career page markdown:`,
    markdown,
  ]
    .filter(Boolean)
    .join('\n');

  const rawText = await generateJsonWithFallback(
    ai,
    prompt,
    {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          jobs: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                company: { type: Type.STRING },
                url: { type: Type.STRING },
              },
              required: ['title', 'company', 'url'],
            },
          },
          nextPageUrl: { type: Type.STRING },
        },
        required: ['jobs', 'nextPageUrl'],
      },
    },
    EXTRACTION_MODELS,
    15000,
  );

  const parsedJson = parseJsonText(rawText);
  const validated = jobExtractionResponseSchema.parse(parsedJson);

  const seen = new Set<string>();
  const results: ExtractedJobCandidate[] = [];

  for (const item of validated.jobs) {
    const resolved = resolveCandidateUrl(item.url, sourceUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    results.push({
      title: item.title,
      company: item.company || sourceName,
      url: resolved,
    });
  }

  let nextPageUrl: string | null = null;
  if (validated.nextPageUrl) {
    const resolvedNext = resolveCandidateUrl(validated.nextPageUrl, sourceUrl);
    try {
      if (
        resolvedNext &&
        resolvedNext !== sourceUrl &&
        new URL(resolvedNext).hostname === new URL(sourceUrl).hostname
      ) {
        nextPageUrl = resolvedNext;
      }
    } catch {
      nextPageUrl = null;
    }
  }

  return { jobs: results, nextPageUrl };
}

export async function parseUploadedCvToTemplate(params: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ rawText: string; template: TailoredCV }> {
  const ai = getGeminiClient();
  const ext = params.filename.toLowerCase().split('.').pop() || '';
  const isPdf = params.mimeType === 'application/pdf' || ext === 'pdf';
  const isDocx =
    params.mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx';

  let extractedText = '';
  let docxLayout: DocxLayoutMeta | undefined;
  const contentParts: Part[] = [];

  const extractionInstruction = [
    `You are a strict verbatim resume parser. Extract the user's uploaded CV into structured JSON WITHOUT rewriting, summarizing, inventing, shortening, or dropping ANY words, metrics, percentages, or tools.`,
    `Rules:`,
    `1. "raw_text": plain-text verbatim transcription of the entire CV.`,
    `2. "template":`,
    `   - "name": candidate full name as written.`,
    `   - "title": headline/role subtitle as written (or "" if none).`,
    `   - "contactLine": pipe-separated contact items as written (e.g., "Giv'atayim, Israel | email | phone | LinkedIn").`,
    `   - "summary": professional summary/profile paragraph COMPLETELY VERBATIM (max ${CV_LIMITS.SUMMARY_MAX} chars).`,
    `   - "experience": ALL work experience roles in exact order, keeping exact role title, company name, period/dates, and EVERY bullet point COMPLETELY VERBATIM from start to finish (do NOT drop the ends of sentences, max ${CV_LIMITS.BULLET_MAX} chars each).`,
    `   - "toolbox": ALL skills/tools grouped into their exact categories and EVERY tool listed COMPLETELY VERBATIM (do NOT truncate or drop tools, max ${CV_LIMITS.TOOLBOX_LINE_MAX} chars per row).`,
    `   - "education": ALL education/coursework/certification lines COMPLETELY VERBATIM (1–${CV_LIMITS.EDUCATION_MAX_LINES} lines).`,
    `   - "extraSections": any other sections present (e.g., "Languages", "Military Service", "Projects"), or [] if none.`,
  ].join('\n');

  if (isPdf) {
    contentParts.push({ text: extractionInstruction });
    contentParts.push({
      inlineData: {
        mimeType: 'application/pdf',
        data: params.buffer.toString('base64'),
      },
    });
  } else if (isDocx) {
    const [result, docxInfo] = await Promise.all([
      mammoth.extractRawText({ buffer: params.buffer }),
      extractDocxInfo(params.buffer).catch(() => null),
    ]);
    extractedText = result.value.trim();
    if (docxInfo) {
      docxLayout = docxInfo.layout;
    }
    if (extractedText.length < 40) {
      throw new Error('Could not extract readable text from the DOCX file.');
    }
    contentParts.push({
      text: `${extractionInstruction}\n\nCV TEXT:\n${extractedText.slice(0, 20000)}`,
    });
  } else if (ext === 'txt' || ext === 'md' || params.mimeType.startsWith('text/')) {
    extractedText = params.buffer.toString('utf8').trim();
    if (extractedText.length < 40) {
      throw new Error('Uploaded text CV is too short or empty.');
    }
    contentParts.push({
      text: `${extractionInstruction}\n\nCV TEXT:\n${extractedText.slice(0, 20000)}`,
    });
  } else {
    throw new Error('Unsupported file format. Please upload a .pdf, .docx, or .txt CV.');
  }

  let lastError: unknown;
  let rawJsonText: string | undefined;

  for (let i = 0; i < TAILORING_MODELS.length; i++) {
    const model = TAILORING_MODELS[i];
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: contentParts }],
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              raw_text: { type: Type.STRING },
              template: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  title: { type: Type.STRING },
                  contactLine: { type: Type.STRING },
                  summary: { type: Type.STRING },
                  experience: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        role: { type: Type.STRING },
                        company: { type: Type.STRING },
                        period: { type: Type.STRING },
                        bullets: { type: Type.ARRAY, items: { type: Type.STRING } },
                      },
                      required: ['role', 'company', 'period', 'bullets'],
                    },
                  },
                  toolbox: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        category: { type: Type.STRING },
                        items: { type: Type.STRING },
                      },
                      required: ['category', 'items'],
                    },
                  },
                  education: { type: Type.ARRAY, items: { type: Type.STRING } },
                  extraSections: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        title: { type: Type.STRING },
                        items: { type: Type.ARRAY, items: { type: Type.STRING } },
                      },
                      required: ['title', 'items'],
                    },
                  },
                },
                required: ['summary', 'experience', 'toolbox', 'education'],
              },
            },
            required: ['raw_text', 'template'],
          },
          httpOptions: { timeout: 30000 },
        },
      });
      rawJsonText = response.text;
      break;
    } catch (error) {
      lastError = error;
      if (i < TAILORING_MODELS.length - 1 && isRetryableGeminiError(error)) {
        continue;
      }
      throw error;
    }
  }

  if (!rawJsonText) {
    throw lastError instanceof Error ? lastError : new Error('Failed to parse uploaded CV.');
  }

  const parsedJson = parseJsonText(rawJsonText);
  const validated = uploadedCvParseResponseSchema.parse(parsedJson);
  const sanitized = sanitizeUploadedMasterCv(validated.template);
  return {
    rawText: extractedText || validated.raw_text,
    template: docxLayout ? { ...sanitized, layout: docxLayout } : sanitized,
  };
}

/**
 * Tightens the longest modified CV blocks (summary / bullets) by ~15-20% characters
 * to recover from a >1 page layout overflow while preserving authentic metrics and clarity.
 */
export async function shortenSurgicalReplacements(params: {
  replacements: TailoringDiffMap;
  allowedBlocks: TailorableBlock[];
  targetReductionRatio?: number;
  strictMaxOverride?: Record<string, number>;
}): Promise<TailoringDiffMap> {
  const ai = getGeminiClient();
  const reductionRatio = params.targetReductionRatio ?? 0.82;
  const blockByNorm = new Map(
    params.allowedBlocks.map((b) => [normalizeForMatch(b.originalText), b]),
  );

  const candidates = Object.entries(params.replacements)
    .map(([origNorm, currentText]) => {
      const block = blockByNorm.get(normalizeForMatch(origNorm));
      const baseMax = params.strictMaxOverride?.[origNorm] ?? currentText.length;
      const targetMax = Math.max(
        40,
        Math.min(
          origNorm.length,
          Math.floor(baseMax * reductionRatio),
        ),
      );
      return {
        origNorm: normalizeForMatch(origNorm),
        currentText,
        section: block?.section ?? 'bullet',
        targetMax,
      };
    })
    .filter((c) => c.section !== 'toolbox' || c.currentText.length > c.origNorm.length)
    .sort((a, b) => b.currentText.length - a.currentText.length);

  if (candidates.length === 0) {
    return params.replacements;
  }

  const prompt = [
    `You are tightening CV sentences so the Word document fits strictly on 1 page.`,
    `For EACH item below, rewrite "current_text" to be AT OR BELOW "MAX_CHARS" (cut filler words cleanly while keeping complete sentences and ALL real metrics/technologies).`,
    `IMPORTANT: Set "original_text" to the EXACT "ORIGINAL_KEY" string verbatim, and make "tailored_text" strictly <= MAX_CHARS characters.`,
    ``,
    ...candidates.map(
      (c, idx) =>
        `[${idx + 1}] MAX_CHARS=${c.targetMax}\nORIGINAL_KEY: ${c.origNorm}\nCURRENT_TEXT: ${c.currentText}`,
    ),
  ].join('\n');

  const rawText = await generateJsonWithFallback(
    ai,
    prompt,
    {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          replacements: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                original_text: { type: Type.STRING },
                tailored_text: { type: Type.STRING },
              },
              required: ['original_text', 'tailored_text'],
            },
          },
        },
        required: ['replacements'],
      },
    },
    TAILORING_MODELS,
    18000,
  );

  const parsed = shortenReplacementsResponseSchema.parse(parseJsonText(rawText));
  const { replacements: sanitizedShortened } = sanitizeSurgicalReplacements(
    parsed.replacements,
    params.allowedBlocks,
  );

  return {
    ...params.replacements,
    ...sanitizedShortened,
  };
}

export interface TailoredJobAnalysis {
  company: string;
  title: string;
  match_score: number;
  summary_hebrew: string;
  changes_made: string;
  replacements: TailoringDiffMap;
  tailored_cv_json: TailoredCV;
}

export async function analyzeAndTailorJob(
  jobUrl: string,
  jobMarkdown: string,
  hints?: {
    company?: string;
    title?: string;
    customPrompt?: string;
    masterTemplate?: TailoredCV;
    tailorableBlocks?: TailorableBlock[];
  },
): Promise<TailoredJobAnalysis> {
  const ai = getGeminiClient();
  const master = hints?.masterTemplate ?? getDefaultMasterCvTemplate();

  // Preferred Surgical Diff Path when tailorableBlocks from the original .docx are provided
  if (hints?.tailorableBlocks && hints.tailorableBlocks.length > 0) {
    const blocks = hints.tailorableBlocks;

    const blocksList = blocks
      .map(
        (b, idx) =>
          `[${idx + 1}] (${b.section}, MAX_CHARS=${b.maxLength}) ${b.originalText}`,
      )
      .join('\n');

    const prompt = [
      `You are an expert Data Analyst CV Editor performing SURGICAL IN-PLACE TEXT REPLACEMENT on an immutable Word (.docx) template.`,
      ``,
      `TAILORABLE CV TEXT BLOCKS (THE ONLY BLOCKS YOU MAY EDIT):`,
      blocksList,
      ``,
      `STRICT RULES:`,
      `1. MINIMAL DIFF: Only return entries in "replacements" for the few blocks (summary, 2-4 experience bullets, or toolbox keyword ordering) where job-specific wording meaningfully improves alignment. Leave unchanged blocks OUT of "replacements".`,
      `2. EXACT ORIGINAL KEY: Each "original_text" in "replacements" MUST be copied character-for-character verbatim from the block text after MAX_CHARS=... above.`,
      `3. STRICT LENGTH CONSTRAINT (MANDATORY): Every "tailored_text" MUST have character length <= MAX_CHARS (ideally 90%–100% of MAX_CHARS, NEVER 1 character longer!). Longer strings wrap onto new lines and break the 1-page Word layout.`,
      `4. TOOLBOX PREFIXES: For toolbox blocks starting with "Category:", preserve the exact "Category:" prefix verbatim and only reorder/emphasize authentic tools from that row.`,
      `5. IMMUTABLE ELEMENTS & ZERO FABRICATION: Headers, contact info, company names, roles, dates, and education are LOCKED outside these blocks. Never invent fake tools, companies, metrics, or placeholders.`,
      `6. "match_score": integer 1-10 reflecting realistic fit.`,
      `7. "summary_hebrew": Concise Hebrew summary (3-5 lines in natural Hebrew) explaining the role, team/domain, key technical requirements, and location/hybrid setup.`,
      `8. "changes_made": Concise English bulleted list (using "- " prefix, 2-4 bullets) summarizing ONLY the exact surgical wording refinements made.`,
      ``,
      hints?.company ? `Hinted Company: ${hints.company}` : '',
      hints?.title ? `Hinted Title: ${hints.title}` : '',
      hints?.customPrompt
        ? `Additional User Focus: ${hints.customPrompt} (emphasize relevant authentic skills while keeping length <= MAX_CHARS)`
        : '',
      `Job URL: ${jobUrl}`,
      ``,
      `Job Posting Markdown:`,
      jobMarkdown,
    ]
      .filter(Boolean)
      .join('\n');

    const rawText = await generateJsonWithFallback(
      ai,
      prompt,
      {
        temperature: 0.15,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            company: { type: Type.STRING },
            title: { type: Type.STRING },
            match_score: { type: Type.INTEGER },
            summary_hebrew: { type: Type.STRING },
            changes_made: { type: Type.STRING },
            replacements: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  original_text: { type: Type.STRING },
                  tailored_text: { type: Type.STRING },
                },
                required: ['original_text', 'tailored_text'],
              },
            },
          },
          required: [
            'company',
            'title',
            'match_score',
            'summary_hebrew',
            'changes_made',
            'replacements',
          ],
        },
      },
      TAILORING_MODELS,
      22000,
    );

    const validated = surgicalJobAnalysisResponseSchema.parse(
      parseJsonText(rawText),
    );

    let { replacements, droppedTooLong } = sanitizeSurgicalReplacements(
      validated.replacements,
      blocks,
    );

    // If Gemini exceeded character budget on any block, ask it once to tighten those entries under original length
    if (droppedTooLong.length > 0) {
      const overMap: TailoringDiffMap = {};
      const maxMap: Record<string, number> = {};
      for (const item of droppedTooLong) {
        overMap[item.original_text] = item.tailored_text;
        maxMap[item.original_text] = item.original_text.length;
      }
      const tightened = await shortenSurgicalReplacements({
        replacements: overMap,
        allowedBlocks: blocks,
        targetReductionRatio: 0.85,
        strictMaxOverride: maxMap,
      }).catch(() => ({}) as TailoringDiffMap);

      for (const [k, v] of Object.entries(tightened)) {
        if (v.length <= k.length && !replacements[k]) {
          replacements[k] = v;
        }
      }
    }

    const tailoredCv = sanitizeTailoredCV(
      applyReplacementsToStructuredCv(master, replacements),
      master,
    );

    return {
      company: validated.company,
      title: validated.title,
      match_score: validated.match_score,
      summary_hebrew: validated.summary_hebrew,
      changes_made: validated.changes_made,
      replacements,
      tailored_cv_json: tailoredCv,
    };
  }

  // Fallback legacy structured-JSON path (only if no tailorableBlocks provided)
  const masterProfileText = [
    `Name: ${master.name || MASTER_CV.name}`,
    `Title: ${master.title || MASTER_CV.title}`,
    master.contactLine ? `Contact: ${master.contactLine}` : '',
    `Summary: ${master.summary}`,
    `Experience (EXACT ${master.experience.length} ROLES IN THIS ORDER):`,
    ...master.experience.map(
      (exp, idx) =>
        `${idx + 1}. ${exp.role} — ${exp.company} (${exp.period})\n   Bullets (${exp.bullets.length}):\n${exp.bullets
          .map((b) => `   - ${b}`)
          .join('\n')}`,
    ),
    `Toolbox (${master.toolbox.length} categories):`,
    ...master.toolbox.map((tb) => `- ${tb.category}: ${tb.items}`),
    `Education: ${master.education.join(' | ')}`,
    ...(master.extraSections ?? []).map(
      (sec) => `${sec.title}: ${sec.items.join(' | ')}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = [
    `You are an expert Data Analyst CV Editor performing LIGHT-TOUCH SURGICAL TAILORING.`,
    `Treat the Master CV below as the user's FINAL POLISHED TEMPLATE. Do NOT rewrite it from scratch.`,
    ``,
    `MASTER CV TEMPLATE (IMMUTABLE STRUCTURE & SOURCE OF TRUTH):`,
    masterProfileText,
    ``,
    `LIGHT-TOUCH TAILORING RULES (STRICT):`,
    `1. Keep at least 80% of the Master CV verbatim. Keep the exact same ${master.experience.length} roles, exact company names, exact dates, exact bullet counts per role, exact education.`,
    `2. Every tailored string MUST be <= its original character length.`,
    `3. ZERO FABRICATION.`,
    ``,
    hints?.company ? `Hinted Company: ${hints.company}` : '',
    hints?.title ? `Hinted Title: ${hints.title}` : '',
    hints?.customPrompt ? `Additional User Focus: ${hints.customPrompt}` : '',
    `Job URL: ${jobUrl}`,
    ``,
    `Job Posting Markdown:`,
    jobMarkdown,
  ]
    .filter(Boolean)
    .join('\n');

  const rawText = await generateJsonWithFallback(
    ai,
    prompt,
    {
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          company: { type: Type.STRING },
          title: { type: Type.STRING },
          match_score: { type: Type.INTEGER },
          summary_hebrew: { type: Type.STRING },
          changes_made: { type: Type.STRING },
          tailored_cv_json: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              experience: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    role: { type: Type.STRING },
                    company: { type: Type.STRING },
                    period: { type: Type.STRING },
                    bullets: { type: Type.ARRAY, items: { type: Type.STRING } },
                  },
                  required: ['role', 'company', 'period', 'bullets'],
                },
              },
              toolbox: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: { type: Type.STRING },
                    items: { type: Type.STRING },
                  },
                  required: ['category', 'items'],
                },
              },
              education: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['summary', 'experience', 'toolbox', 'education'],
          },
        },
        required: [
          'company',
          'title',
          'match_score',
          'summary_hebrew',
          'changes_made',
          'tailored_cv_json',
        ],
      },
    },
    TAILORING_MODELS,
    22000,
  );

  const validated = jobAnalysisResponseSchema.parse(parseJsonText(rawText));
  const sanitized = sanitizeTailoredCV(validated.tailored_cv_json, master);

  return {
    company: validated.company,
    title: validated.title,
    match_score: validated.match_score,
    summary_hebrew: validated.summary_hebrew,
    changes_made: validated.changes_made,
    replacements: {},
    tailored_cv_json: sanitized,
  };
}
