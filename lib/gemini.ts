import { GoogleGenAI, Type, type GenerateContentConfig } from '@google/genai';
import { MASTER_CV } from './master-cv';
import {
  CV_LIMITS,
  jobAnalysisResponseSchema,
  jobExtractionResponseSchema,
  sanitizeTailoredCV,
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
  hints?: { company?: string; title?: string; customPrompt?: string },
): Promise<TailoredJobAnalysis> {
  const ai = getGeminiClient();

  const masterProfileText = [
    `Name: ${MASTER_CV.name}`,
    `Title: ${MASTER_CV.title}`,
    `Experience (EXACT 3 ROLES IN THIS ORDER):`,
    ...MASTER_CV.experience.map(
      (exp, idx) =>
        `${idx + 1}. ${exp.role} — ${exp.company} (${exp.period}): ${exp.authenticContext}`,
    ),
    `Education: ${MASTER_CV.education.join(' | ')}`,
    `Authentic Toolbox: ${MASTER_CV.toolboxList.join(', ')}`,
  ].join('\n');

  const prompt = [
    `You are an expert Data Analyst CV Strategist & Career Coach.`,
    `Analyze the job posting below and tailor Eden Hadad's strictly 1-page CV for maximum relevance.`,
    ``,
    `IMMUTABLE SOURCE OF TRUTH (NEVER INVENT FAKE COMPANIES, DEGREES, DATES, METRICS, OR TOOLS):`,
    masterProfileText,
    ``,
    `STRICT RULES:`,
    `1. You may rephrase, highlight, and prioritize skills/projects from the Master CV to align with the job posting's keywords, but NEVER fabricate any company, degree, certification, date, or tool that Eden does not possess.`,
    `2. "match_score": integer 1-10 reflecting realistic fit for Eden's 5+ years Data Analyst profile.`,
    `3. "summary_hebrew": Concise Hebrew summary (3-5 bullet points or short paragraph in natural Hebrew) explaining the role, team/domain, key technical requirements, and location/hybrid setup.`,
    `4. "changes_made": Concise English bulleted list (using "- " prefix per line, 3-5 bullets) explaining specifically what was emphasized or rephrased in the tailored CV.`,
    `5. "tailored_cv_json" HARD CHARACTER & STRUCTURE LIMITS (CRITICAL SO PDF STAYS STRICTLY 1 PAGE):`,
    `   - summary: max ${CV_LIMITS.SUMMARY_MAX} characters.`,
    `   - experience: EXACTLY 3 items matching the 3 Master CV roles in reverse-chronological order (Freelance, Montara, Shufersal). Keep company & period faithful, and provide EXACTLY 3 concise impact bullets per role, each STRICTLY <= ${CV_LIMITS.BULLET_MAX} characters.`,
    `   - toolbox: EXACTLY 4 categories (e.g., "Data & Languages", "BI & Visualization", "Analytics & ML", "Data Engineering & AI"). Each category + ": " + items must be <= ${CV_LIMITS.TOOLBOX_LINE_MAX} characters total (category <= ${CV_LIMITS.TOOLBOX_CATEGORY_MAX} chars). Only include authentic tools from the Master CV, ordered by relevance to the job.`,
    `   - education: max ${CV_LIMITS.EDUCATION_MAX_LINES} lines matching the Master CV education.`,
    ``,
    hints?.company ? `Hinted Company: ${hints.company}` : '',
    hints?.title ? `Hinted Title: ${hints.title}` : '',
    hints?.customPrompt
      ? `Additional User Focus: ${hints.customPrompt} (prioritize authentic relevant experience/keywords accordingly while NEVER inventing fake companies, degrees, or tools)`
      : '',
    `Job URL: ${jobUrl}`,
    ``,
    `Job Posting Markdown:`,
    jobMarkdown,
  ]
    .filter(Boolean)
    .join('\n');

  const rawText = await generateJsonWithFallback(ai, prompt, {
    temperature: 0.2,
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
    tailored_cv_json: sanitizeTailoredCV(validated.tailored_cv_json),
  };
}
