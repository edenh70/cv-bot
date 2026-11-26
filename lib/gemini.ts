import { GoogleGenAI, Type, type GenerateContentConfig, type Part } from '@google/genai';
import mammoth from 'mammoth';
import { extractDocxInfo, type DocxLayoutMeta } from './docx-template';
import { getDefaultMasterCvTemplate, MASTER_CV } from './master-cv';
import {
  CV_LIMITS,
  jobAnalysisResponseSchema,
  jobExtractionResponseSchema,
  sanitizeTailoredCV,
  sanitizeUploadedMasterCv,
  uploadedCvParseResponseSchema,
} from './cv-schema';
import { resolveCandidateUrl } from './jina';
import type {
  ExtractedJobCandidate,
  JobExtractionResult,
  TailoredCV,
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

  const rawText = await generateJsonWithFallback(ai, prompt, {
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
  }, EXTRACTION_MODELS, 15000);

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

export interface TailoredJobAnalysis {
  company: string;
  title: string;
  match_score: number;
  summary_hebrew: string;
  changes_made: string;
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
  },
): Promise<TailoredJobAnalysis> {
  const ai = getGeminiClient();
  const master = hints?.masterTemplate ?? getDefaultMasterCvTemplate();

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
    `1. PRESERVE STRUCTURE & WORDING: Keep at least 75–85% of the Master CV's exact wording verbatim. Keep the exact same ${master.experience.length} roles, exact company names, exact dates, exact bullet counts per role, exact education, and exact extra sections.`,
    `2. SURGICAL SKILL ALIGNMENT ONLY: Make only minimal, targeted keyword adjustments in "summary" and at most 1–2 bullets per role to highlight required skills from the job description. Keep edited bullets roughly the SAME character length (±10%) as the original Master CV bullets so the original 1-page Word template never overflows!`,
    `3. ZERO FABRICATION: NEVER invent fake companies, roles, degrees, dates, metrics, or tools not present in the Master CV. In "toolbox", keep all authentic tools and simply reorder items so job-relevant skills appear first.`,
    `4. "match_score": integer 1-10 reflecting realistic fit.`,
    `5. "summary_hebrew": Concise Hebrew summary (3-5 lines in natural Hebrew) explaining the role, team/domain, key technical requirements, and location/hybrid setup.`,
    `6. "changes_made": Concise English bulleted list (using "- " prefix, 2-4 bullets) stating ONLY the minimal surgical edits made to align with the job.`,
    `7. CHARACTER LIMITS (SO PDF STAYS STRICTLY 1 PAGE):`,
    `   - summary: max ${CV_LIMITS.SUMMARY_MAX} chars`,
    `   - each bullet: max ${CV_LIMITS.BULLET_MAX} chars`,
    `   - each toolbox row ("category: items"): max ${CV_LIMITS.TOOLBOX_LINE_MAX} chars`,
    ``,
    hints?.company ? `Hinted Company: ${hints.company}` : '',
    hints?.title ? `Hinted Title: ${hints.title}` : '',
    hints?.customPrompt
      ? `Additional User Focus: ${hints.customPrompt} (emphasize relevant authentic skills while preserving the template)`
      : '',
    `Job URL: ${jobUrl}`,
    ``,
    `Job Posting Markdown:`,
    jobMarkdown,
  ]
    .filter(Boolean)
    .join('\n');

  const rawText = await generateJsonWithFallback(ai, prompt, {
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
                  bullets: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
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
            education: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
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
  }, TAILORING_MODELS, 22000);

  const parsedJson = parseJsonText(rawText);
  const validated = jobAnalysisResponseSchema.parse(parsedJson);

  return {
    company: validated.company,
    title: validated.title,
    match_score: validated.match_score,
    summary_hebrew: validated.summary_hebrew,
    changes_made: validated.changes_made,
    tailored_cv_json: sanitizeTailoredCV(validated.tailored_cv_json, master),
  };
}
