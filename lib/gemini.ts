import { GoogleGenAI, Type } from '@google/genai';
import { MASTER_CV } from './master-cv';
import {
  CV_LIMITS,
  jobAnalysisResponseSchema,
  jobExtractionResponseSchema,
  sanitizeTailoredCV,
} from './cv-schema';
import { resolveCandidateUrl } from './jina';
import type { ExtractedJobCandidate, TailoredCV } from './types';

const GEMINI_MODEL = 'gemini-2.5-flash';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }
  return new GoogleGenAI({ apiKey });
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
): Promise<ExtractedJobCandidate[]> {
  const ai = getGeminiClient();

  const prompt = [
    `You are an expert technical recruiter extracting relevant Data Analyst job listings from a company career page.`,
    `Source Name: ${sourceName}`,
    `Source URL: ${sourceUrl}`,
    ``,
    `Inclusion criteria (ALL must hold):`,
    `1. Role title is Data Analyst, Product Analyst, BI Analyst, Business Intelligence Analyst, Marketing/Growth Data Analyst, or Analytics Engineer/Analyst requiring 1–5 years of experience.`,
    `2. Exclude senior staff/principal/director/VP roles, pure Data Engineer roles, pure Software Engineer roles, or internships.`,
    `3. Location must be Israel, Tel Aviv, Central Israel, Hybrid (Israel), or Remote (eligible from Israel). Exclude roles strictly requiring relocation to US/EU-only offices.`,
    `4. Each entry MUST have a specific job posting URL (resolve relative links against ${sourceUrl} if needed). Skip generic career homepages without a job ID/slug.`,
    ``,
    `Career page markdown:`,
    markdown,
  ].join('\n');

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
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
        },
        required: ['jobs'],
      },
    },
  });

  const parsedJson = parseJsonText(response.text);
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

  return results;
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
  hints?: { company?: string; title?: string },
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
    `Job URL: ${jobUrl}`,
    ``,
    `Job Posting Markdown:`,
    jobMarkdown,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
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
    },
  });

  const parsedJson = parseJsonText(response.text);
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
