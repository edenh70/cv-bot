import { z } from 'zod';
import { getDefaultMasterCvTemplate } from './master-cv';
import type {
  TailoredCV,
  TailoredCVExperienceItem,
  TailoredCVExtraSection,
  TailoredCVToolboxCategory,
} from './types';

export const CV_LIMITS = {
  SUMMARY_MAX: 550,
  EXPERIENCE_COUNT: 3,
  MAX_EXPERIENCE_ROLES: 6,
  BULLETS_PER_ROLE: 3,
  MAX_BULLETS_PER_ROLE: 6,
  BULLET_MAX: 320,
  ROLE_MAX: 100,
  COMPANY_MAX: 100,
  PERIOD_MAX: 50,
  TOOLBOX_COUNT: 4,
  MAX_TOOLBOX_CATEGORIES: 6,
  TOOLBOX_LINE_MAX: 320,
  TOOLBOX_CATEGORY_MAX: 40,
  EDUCATION_MAX_LINES: 5,
  EDUCATION_LINE_MAX: 220,
  MAX_EXTRA_SECTIONS: 3,
  EXTRA_SECTION_ITEMS_MAX: 6,
  EXTRA_SECTION_ITEM_MAX: 220,
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
  name: z.string().optional(),
  title: z.string().optional(),
  contactLine: z.string().optional(),
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
  extraSections: z
    .array(
      z.object({
        title: z.string().default(''),
        items: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  layout: z
    .object({
      sectionOrder: z
        .array(z.enum(['experience', 'education', 'toolbox']))
        .optional(),
      hasSummaryHeading: z.boolean().optional(),
      accentColor: z.string().optional(),
      inlineHeaderContact: z.boolean().optional(),
    })
    .optional(),
});

export const surgicalReplacementItemSchema = z.object({
  original_text: z.string().trim().min(1),
  tailored_text: z.string().trim().min(1),
});

const normalizedMatchScoreSchema = z.preprocess((val) => {
  const n = typeof val === 'string' ? Number(val) : typeof val === 'number' ? val : NaN;
  if (!Number.isFinite(n)) return 5;
  const scaled = n > 10 && n <= 100 ? Math.round(n / 10) : Math.round(n);
  return Math.max(1, Math.min(10, scaled));
}, z.number().int().min(1).max(10));

export const surgicalJobAnalysisResponseSchema = z.object({
  company: z.string().trim().min(1).max(120),
  title: z.string().trim().min(2).max(160),
  match_score: normalizedMatchScoreSchema,
  summary_hebrew: z.string().trim().min(5).max(1500),
  changes_made: z.string().trim().min(5).max(2000),
  replacements: z.array(surgicalReplacementItemSchema).default([]),
});

export const shortenReplacementsResponseSchema = z.object({
  replacements: z.array(surgicalReplacementItemSchema).default([]),
});

export const jobAnalysisResponseSchema = z.object({
  company: z.string().trim().min(1).max(120),
  title: z.string().trim().min(2).max(160),
  match_score: normalizedMatchScoreSchema,
  summary_hebrew: z.string().trim().min(5).max(1500),
  changes_made: z.string().trim().min(5).max(2000),
  tailored_cv_json: tailoredCVRawSchema,
});

export const uploadedCvParseResponseSchema = z.object({
  raw_text: z.string().trim().min(30),
  template: tailoredCVRawSchema,
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
  const candidate =
    lastSpace > Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return candidate.replace(/[,;:\-–—]+$/g, '').trim();
}

function sanitizeExtraSections(
  rawSections: Array<{ title: string; items: string[] }> | undefined,
): TailoredCVExtraSection[] | undefined {
  if (!rawSections || rawSections.length === 0) return undefined;
  const cleaned = rawSections
    .map((sec) => ({
      title: truncateClean(sec.title || '', 45),
      items: (sec.items ?? [])
        .map((it) => truncateClean(it, CV_LIMITS.EXTRA_SECTION_ITEM_MAX))
        .filter((it) => it.length > 0)
        .slice(0, CV_LIMITS.EXTRA_SECTION_ITEMS_MAX),
    }))
    .filter((sec) => sec.title.length > 0 && sec.items.length > 0)
    .slice(0, CV_LIMITS.MAX_EXTRA_SECTIONS);

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Sanitizes a tailored CV against a Master CV template (defaulting to the
 * built-in MASTER_CV when no custom template is provided), locking employers,
 * periods, structure, and extra sections so nothing can be hallucinated.
 */
export function sanitizeTailoredCV(
  raw: unknown,
  masterTemplate: TailoredCV = getDefaultMasterCvTemplate(),
): TailoredCV {
  const parsed = tailoredCVRawSchema.safeParse(raw);
  const input = parsed.success
    ? parsed.data
    : {
        summary: '',
        experience: [],
        toolbox: [],
        education: [],
      };

  const summary = truncateClean(
    input.summary || masterTemplate.summary,
    CV_LIMITS.SUMMARY_MAX,
  );

  const experience = masterTemplate.experience.map(
    (masterRole, idx): TailoredCVExperienceItem => {
      const candidate = input.experience[idx];
      const roleTitle = truncateClean(
        candidate?.role?.trim() || masterRole.role,
        CV_LIMITS.ROLE_MAX,
      );

      const rawBullets = Array.isArray(candidate?.bullets) ? candidate.bullets : [];
      const targetBulletCount = Math.max(
        1,
        Math.min(masterRole.bullets.length, CV_LIMITS.MAX_BULLETS_PER_ROLE),
      );

      const bullets: string[] = [];
      for (let bIdx = 0; bIdx < targetBulletCount; bIdx++) {
        const chosen =
          rawBullets[bIdx]?.trim() ||
          masterRole.bullets[bIdx] ||
          masterRole.bullets[0] ||
          '';
        const cleaned = truncateClean(chosen, CV_LIMITS.BULLET_MAX);
        if (cleaned) bullets.push(cleaned);
      }

      return {
        role: roleTitle,
        // Always lock employer & dates to the Master CV template
        company: masterRole.company,
        period: masterRole.period,
        bullets,
      };
    },
  );

  const toolboxBase =
    masterTemplate.toolbox.length > 0
      ? masterTemplate.toolbox
      : getDefaultMasterCvTemplate().toolbox;

  const toolbox = toolboxBase.map(
    (defaultCat, idx): TailoredCVToolboxCategory => {
      const candidate = input.toolbox[idx];
      const category = truncateClean(
        candidate?.category?.trim() || defaultCat.category,
        CV_LIMITS.TOOLBOX_CATEGORY_MAX,
      );
      const maxItemsLen = Math.max(
        20,
        CV_LIMITS.TOOLBOX_LINE_MAX - category.length - 2,
      );
      const items = truncateClean(
        candidate?.items?.trim() || defaultCat.items,
        maxItemsLen,
      );
      return { category, items };
    },
  );

  const rawEdu = input.education
    .map((line) => truncateClean(line, CV_LIMITS.EDUCATION_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, CV_LIMITS.EDUCATION_MAX_LINES);

  const education =
    rawEdu.length > 0
      ? rawEdu
      : masterTemplate.education.map((line) =>
          truncateClean(line, CV_LIMITS.EDUCATION_LINE_MAX),
        );

  const extraSections = sanitizeExtraSections(
    masterTemplate.extraSections ?? input.extraSections,
  );
  const layout = masterTemplate.layout ?? input.layout;

  return {
    ...(masterTemplate.name ? { name: truncateClean(masterTemplate.name, 70) } : {}),
    ...(masterTemplate.title ? { title: truncateClean(masterTemplate.title, 110) } : {}),
    ...(masterTemplate.contactLine
      ? { contactLine: truncateClean(masterTemplate.contactLine, 170) }
      : {}),
    summary,
    experience,
    toolbox,
    education,
    ...(extraSections ? { extraSections } : {}),
    ...(layout ? { layout } : {}),
  };
}

/**
 * Sanitizes a freshly parsed uploaded Master CV verbatim without forcing it
 * into the built-in 3-role / 4-toolbox shape.
 */
export function sanitizeUploadedMasterCv(raw: unknown): TailoredCV {
  const parsed = tailoredCVRawSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Parsed uploaded CV did not match expected structure.');
  }

  const input = parsed.data;
  const summary = truncateClean(input.summary, CV_LIMITS.SUMMARY_MAX);

  const experience = input.experience
    .slice(0, CV_LIMITS.MAX_EXPERIENCE_ROLES)
    .map((item): TailoredCVExperienceItem => {
      const bullets = item.bullets
        .map((b) => truncateClean(b, CV_LIMITS.BULLET_MAX))
        .filter((b) => b.length > 0)
        .slice(0, CV_LIMITS.MAX_BULLETS_PER_ROLE);
      return {
        role: truncateClean(item.role, CV_LIMITS.ROLE_MAX),
        company: truncateClean(item.company || '', CV_LIMITS.COMPANY_MAX),
        period: truncateClean(item.period || '', CV_LIMITS.PERIOD_MAX),
        bullets,
      };
    })
    .filter((item) => item.role.length > 0 && item.bullets.length > 0);

  const toolbox = input.toolbox
    .slice(0, CV_LIMITS.MAX_TOOLBOX_CATEGORIES)
    .map((group): TailoredCVToolboxCategory => {
      const category = truncateClean(
        group.category || 'Skills',
        CV_LIMITS.TOOLBOX_CATEGORY_MAX,
      );
      const maxItemsLen = Math.max(
        20,
        CV_LIMITS.TOOLBOX_LINE_MAX - category.length - 2,
      );
      return {
        category,
        items: truncateClean(group.items, maxItemsLen),
      };
    })
    .filter((group) => group.items.length > 0);

  const education = input.education
    .map((line) => truncateClean(line, CV_LIMITS.EDUCATION_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, CV_LIMITS.EDUCATION_MAX_LINES);

  const extraSections = sanitizeExtraSections(input.extraSections);

  return {
    ...(input.name?.trim() ? { name: truncateClean(input.name, 70) } : {}),
    ...(input.title?.trim() ? { title: truncateClean(input.title, 110) } : {}),
    ...(input.contactLine?.trim()
      ? { contactLine: truncateClean(input.contactLine, 170) }
      : {}),
    summary,
    experience,
    toolbox,
    education,
    ...(extraSections ? { extraSections } : {}),
    ...(input.layout ? { layout: input.layout } : {}),
  };
}
