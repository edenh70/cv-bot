import { z } from 'zod';
import { MASTER_CV } from './master-cv';
import type {
  TailoredCV,
  TailoredCVExperienceItem,
  TailoredCVToolboxCategory,
} from './types';

export const CV_LIMITS = {
  SUMMARY_MAX: 260,
  EXPERIENCE_COUNT: 3,
  BULLETS_PER_ROLE: 3,
  BULLET_MAX: 115,
  ROLE_MAX: 55,
  TOOLBOX_COUNT: 4,
  TOOLBOX_LINE_MAX: 95,
  TOOLBOX_CATEGORY_MAX: 26,
  EDUCATION_MAX_LINES: 2,
  EDUCATION_LINE_MAX: 95,
} as const;

export const jobExtractionCandidateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  company: z.string().trim().min(1).max(120),
  url: z.string().trim().min(5).max(1000),
});

export const jobExtractionResponseSchema = z.object({
  jobs: z.array(jobExtractionCandidateSchema).default([]),
  nextPageUrl: z.string().optional().default(''),
});

export const tailoredCVRawSchema = z.object({
  summary: z.string().default(''),
  experience: z
    .array(
      z.object({
        role: z.string().default(''),
        company: z.string().optional().default(''),
        period: z.string().optional().default(''),
        bullets: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  toolbox: z
    .array(
      z.object({
        category: z.string().default(''),
        items: z.string().default(''),
      }),
    )
    .default([]),
  education: z.array(z.string()).default([]),
});

export const jobAnalysisResponseSchema = z.object({
  company: z.string().trim().min(1).max(120),
  title: z.string().trim().min(2).max(160),
  match_score: z.coerce.number().int().min(1).max(10),
  summary_hebrew: z.string().trim().min(5).max(1500),
  changes_made: z.string().trim().min(5).max(2000),
  tailored_cv_json: tailoredCVRawSchema,
});

/**
 * Collapses whitespace/newlines and truncates cleanly at the last word boundary
 * so output is mathematically guaranteed to be <= maxLen characters.
 */
export function truncateClean(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (maxLen <= 0) return '';
  if (normalized.length <= maxLen) return normalized;

  const sliced = normalized.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(' ');
  const candidate = lastSpace > Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return candidate.replace(/[,;:\-–—]+$/g, '').trim();
}

/**
 * Enforces all strict 1-page CV schema limits and locks authentic employer names
 * and dates to MASTER_CV so the PDF mathematically cannot overflow to page 2.
 */
export function sanitizeTailoredCV(raw: unknown): TailoredCV {
  const parsed = tailoredCVRawSchema.safeParse(raw);
  const input = parsed.success
    ? parsed.data
    : { summary: '', experience: [], toolbox: [], education: [] };

  const summary = truncateClean(
    input.summary || MASTER_CV.defaultSummary,
    CV_LIMITS.SUMMARY_MAX,
  );

  const experience = MASTER_CV.experience.map((masterRole, idx): TailoredCVExperienceItem => {
    const candidate = input.experience[idx];
    const roleTitle = truncateClean(
      candidate?.role?.trim() || masterRole.role,
      CV_LIMITS.ROLE_MAX,
    );

    const rawBullets = Array.isArray(candidate?.bullets) ? candidate.bullets : [];
    const bullets: [string, string, string] = [
      truncateClean(rawBullets[0]?.trim() || masterRole.bullets[0], CV_LIMITS.BULLET_MAX),
      truncateClean(rawBullets[1]?.trim() || masterRole.bullets[1], CV_LIMITS.BULLET_MAX),
      truncateClean(rawBullets[2]?.trim() || masterRole.bullets[2], CV_LIMITS.BULLET_MAX),
    ];

    return {
      role: roleTitle,
      // Always lock employer & dates to MASTER_CV to prevent hallucination
      company: masterRole.company,
      period: masterRole.period,
      bullets,
    };
  }) as [
    TailoredCVExperienceItem,
    TailoredCVExperienceItem,
    TailoredCVExperienceItem,
  ];

  const toolbox = MASTER_CV.defaultToolbox.map((defaultCat, idx): TailoredCVToolboxCategory => {
    const candidate = input.toolbox[idx];
    const category = truncateClean(
      candidate?.category?.trim() || defaultCat.category,
      CV_LIMITS.TOOLBOX_CATEGORY_MAX,
    );
    // Reserve 2 chars for ": " separator between category and items
    const maxItemsLen = Math.max(20, CV_LIMITS.TOOLBOX_LINE_MAX - category.length - 2);
    const items = truncateClean(
      candidate?.items?.trim() || defaultCat.items,
      maxItemsLen,
    );

    return { category, items };
  }) as [
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
  ];

  const rawEdu = input.education
    .map((line) => truncateClean(line, CV_LIMITS.EDUCATION_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, CV_LIMITS.EDUCATION_MAX_LINES);

  const education =
    rawEdu.length > 0
      ? rawEdu
      : MASTER_CV.education.map((line) =>
          truncateClean(line, CV_LIMITS.EDUCATION_LINE_MAX),
        );

  return {
    summary,
    experience,
    toolbox,
    education,
  };
}
