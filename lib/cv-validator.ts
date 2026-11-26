import { renderCvPdfBuffer, type PdfDensity } from './cv-pdf';
import {
  CV_LIMITS,
  sanitizeTailoredCV,
  sanitizeUploadedMasterCv,
  truncateClean,
} from './cv-schema';
import type { TailoredCV } from './types';

export const CV_PDF_BOUNDS = {
  MIN_BYTES: 2_500,
  MAX_BYTES: 2 * 1024 * 1024,
  REQUIRED_PAGES: 1,
} as const;

export const LEAKAGE_PATTERN =
  /\[INSERT|TODO\b|FIXME\b|\bTBD\b|Lorem ipsum|As an AI|Here is your|```|\{\{|\}\}|\bundefined\b|\bNaN\b/i;

const HEBREW_CHAR_PATTERN = /[\u0590-\u05FF]/;
const DENSITY_ORDER: PdfDensity[] = ['normal', 'compact', 'tight', 'ultra'];

export class CvValidationError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`CV validation failed: ${reasons.join('; ')}`);
    this.name = 'CvValidationError';
    this.reasons = reasons;
  }
}

export interface PdfBinaryValidationResult {
  valid: boolean;
  byteLength: number;
  pageCount: number;
  errors: string[];
}

export interface CvContentValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidatedCvMetadata {
  match_score?: number;
  summary_hebrew?: string;
  changes_made?: string;
}

export function countPdfPages(buffer: Buffer): number {
  const pdfLatin1 = buffer.toString('latin1');
  const matches = pdfLatin1.match(/\/Type\s*\/Page\b(?!s)/g);
  return matches ? matches.length : 0;
}

export function validatePdfBinary(buffer: Buffer): PdfBinaryValidationResult {
  const errors: string[] = [];
  const byteLength = buffer.length;

  if (byteLength === 0) {
    errors.push('PDF buffer is empty.');
    return { valid: false, byteLength, pageCount: 0, errors };
  }

  const pdfLatin1 = buffer.toString('latin1');
  if (!pdfLatin1.startsWith('%PDF-')) {
    errors.push('PDF buffer does not start with valid %PDF- magic header.');
  }
  if (!pdfLatin1.includes('%%EOF')) {
    errors.push('PDF buffer is truncated (missing %%EOF trailer).');
  }

  if (byteLength < CV_PDF_BOUNDS.MIN_BYTES) {
    errors.push(
      `PDF size (${byteLength} bytes) is below minimum threshold (${CV_PDF_BOUNDS.MIN_BYTES} bytes).`,
    );
  }
  if (byteLength > CV_PDF_BOUNDS.MAX_BYTES) {
    errors.push(
      `PDF size (${byteLength} bytes) exceeds maximum threshold (${CV_PDF_BOUNDS.MAX_BYTES} bytes).`,
    );
  }

  const pageCount = countPdfPages(buffer);
  if (pageCount !== CV_PDF_BOUNDS.REQUIRED_PAGES) {
    errors.push(
      `PDF page count must be strictly ${CV_PDF_BOUNDS.REQUIRED_PAGES}, got ${pageCount}.`,
    );
  }

  return {
    valid: errors.length === 0,
    byteLength,
    pageCount,
    errors,
  };
}

export function validateTailoredCvContent(
  cv: TailoredCV,
  meta?: ValidatedCvMetadata,
  masterTemplate?: TailoredCV,
): CvContentValidationResult {
  const errors: string[] = [];

  if (!cv || typeof cv !== 'object') {
    return { valid: false, errors: ['tailored_cv_json is missing or invalid.'] };
  }

  const summary = (cv.summary ?? '').trim();
  if (summary.length > CV_LIMITS.SUMMARY_MAX) {
    errors.push(
      `Summary length (${summary.length}) exceeds max ${CV_LIMITS.SUMMARY_MAX} chars.`,
    );
  } else if (!masterTemplate && summary.length === 0 && cv.experience.length === 0) {
    errors.push('CV must contain either a summary or experience entries.');
  } else if (masterTemplate && masterTemplate.summary.trim().length >= 40 && summary.length < 30) {
    errors.push(`Summary length (${summary.length}) is too short.`);
  }

  if (!Array.isArray(cv.experience) || cv.experience.length === 0) {
    errors.push('Experience must contain at least 1 role.');
  } else if (masterTemplate && cv.experience.length !== masterTemplate.experience.length) {
    errors.push(
      `Experience count (${cv.experience.length}) must match Master CV (${masterTemplate.experience.length}).`,
    );
  } else {
    cv.experience.forEach((role, idx) => {
      if (!role.role || role.role.trim().length === 0 || role.role.length > CV_LIMITS.ROLE_MAX) {
        errors.push(`Experience[${idx}].role is invalid or exceeds ${CV_LIMITS.ROLE_MAX} chars.`);
      }
      if (masterTemplate) {
        const masterRole = masterTemplate.experience[idx];
        if (masterRole && role.company !== masterRole.company) {
          errors.push(
            `Experience[${idx}].company ("${role.company}") does not match Master CV ("${masterRole.company}").`,
          );
        }
        if (masterRole && role.period !== masterRole.period) {
          errors.push(
            `Experience[${idx}].period ("${role.period}") does not match Master CV ("${masterRole.period}").`,
          );
        }
      }
      if (!Array.isArray(role.bullets) || role.bullets.length === 0) {
        errors.push(`Experience[${idx}] must contain at least 1 bullet.`);
      } else {
        role.bullets.forEach((b, bIdx) => {
          const trimmed = (b ?? '').trim();
          if (trimmed.length < 12 || trimmed.length > CV_LIMITS.BULLET_MAX) {
            errors.push(
              `Experience[${idx}].bullets[${bIdx}] length (${trimmed.length}) must be 12–${CV_LIMITS.BULLET_MAX} chars.`,
            );
          }
        });
      }
    });
  }

  if (!Array.isArray(cv.toolbox) || cv.toolbox.length === 0) {
    errors.push('Toolbox must contain at least 1 skill category.');
  } else {
    cv.toolbox.forEach((group, idx) => {
      const category = (group.category ?? '').trim();
      const items = (group.items ?? '').trim();
      if (!category || !items) {
        errors.push(`Toolbox[${idx}] category and items must be non-empty.`);
      } else if (category.length + 2 + items.length > CV_LIMITS.TOOLBOX_LINE_MAX) {
        errors.push(
          `Toolbox[${idx}] combined line exceeds ${CV_LIMITS.TOOLBOX_LINE_MAX} chars.`,
        );
      }
    });
  }

  if (!Array.isArray(cv.education) || cv.education.length === 0) {
    errors.push('Education must contain at least 1 entry.');
  } else if (cv.education.length > CV_LIMITS.EDUCATION_MAX_LINES) {
    errors.push(`Education must not exceed ${CV_LIMITS.EDUCATION_MAX_LINES} lines.`);
  }

  const allTextFields: string[] = [
    cv.name ?? '',
    cv.title ?? '',
    cv.contactLine ?? '',
    cv.summary ?? '',
    ...(cv.experience ?? []).flatMap((e) => [e.role ?? '', e.company ?? '', ...(e.bullets ?? [])]),
    ...(cv.toolbox ?? []).flatMap((t) => [t.category ?? '', t.items ?? '']),
    ...(cv.education ?? []),
    ...(cv.extraSections ?? []).flatMap((s) => [s.title ?? '', ...(s.items ?? [])]),
  ];

  for (const field of allTextFields) {
    const match = field.match(LEAKAGE_PATTERN);
    if (match) {
      errors.push(`Disallowed placeholder or LLM leakage detected: "${match[0]}".`);
      break;
    }
  }

  if (meta) {
    if (
      meta.match_score !== undefined &&
      (!Number.isInteger(meta.match_score) || meta.match_score < 1 || meta.match_score > 10)
    ) {
      errors.push(`match_score (${meta.match_score}) must be an integer between 1 and 10.`);
    }
    if (meta.summary_hebrew !== undefined) {
      const hebrewTrimmed = meta.summary_hebrew.trim();
      if (hebrewTrimmed.length < 15 || !HEBREW_CHAR_PATTERN.test(hebrewTrimmed)) {
        errors.push('summary_hebrew must contain a valid Hebrew role summary (>= 15 chars).');
      }
    }
    if (meta.changes_made !== undefined && meta.changes_made.trim().length < 10) {
      errors.push('changes_made must describe the CV tailoring changes.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function trimCvSlightly(cv: TailoredCV, factor: number): TailoredCV {
  return {
    ...cv,
    summary: cv.summary
      ? truncateClean(cv.summary, Math.max(80, Math.floor(cv.summary.length * factor)))
      : '',
    experience: cv.experience.map((exp) => ({
      ...exp,
      bullets: exp.bullets.map((b) =>
        truncateClean(b, Math.max(45, Math.floor(b.length * factor))),
      ),
    })),
  };
}

export async function validateAndRenderCv(
  rawCv: TailoredCV,
  meta?: ValidatedCvMetadata,
  options?: {
    masterTemplate?: TailoredCV;
    preserveUploadedShape?: boolean;
  },
): Promise<{
  cv: TailoredCV;
  pdfBuffer: Buffer;
  byteLength: number;
  pageCount: number;
  density: PdfDensity;
}> {
  const preserveUploadedShape = Boolean(options?.preserveUploadedShape);
  let currentCv = preserveUploadedShape
    ? sanitizeUploadedMasterCv(rawCv)
    : sanitizeTailoredCV(rawCv, options?.masterTemplate);

  const contentCheck = validateTailoredCvContent(
    currentCv,
    meta,
    preserveUploadedShape ? undefined : options?.masterTemplate,
  );
  if (!contentCheck.valid) {
    throw new CvValidationError(contentCheck.errors);
  }

  // First try progressively tighter densities to preserve 100% of user's wording
  let chosenDensity: PdfDensity = 'normal';
  let pdfBuffer: Buffer = Buffer.alloc(0);
  let binaryCheck: PdfBinaryValidationResult = {
    valid: false,
    byteLength: 0,
    pageCount: 0,
    errors: [],
  };

  for (const density of DENSITY_ORDER) {
    chosenDensity = density;
    pdfBuffer = await renderCvPdfBuffer(currentCv, {
      density,
      masterTemplate: options?.masterTemplate,
      preserveUploadedShape: true,
    });
    binaryCheck = validatePdfBinary(pdfBuffer);
    if (binaryCheck.valid) {
      return {
        cv: currentCv,
        pdfBuffer,
        byteLength: binaryCheck.byteLength,
        pageCount: binaryCheck.pageCount,
        density: chosenDensity,
      };
    }
    if (binaryCheck.pageCount <= CV_PDF_BOUNDS.REQUIRED_PAGES) {
      break;
    }
  }

  // Only if 'ultra' density still overflows beyond 1 page, trim text gently up to 3 attempts
  for (
    let attempt = 0;
    attempt < 3 && binaryCheck.pageCount > CV_PDF_BOUNDS.REQUIRED_PAGES;
    attempt++
  ) {
    currentCv = trimCvSlightly(currentCv, 0.88);
    pdfBuffer = await renderCvPdfBuffer(currentCv, {
      density: 'ultra',
      masterTemplate: options?.masterTemplate,
      preserveUploadedShape: true,
    });
    binaryCheck = validatePdfBinary(pdfBuffer);
    chosenDensity = 'ultra';
  }

  if (!binaryCheck.valid) {
    throw new CvValidationError(binaryCheck.errors);
  }

  return {
    cv: currentCv,
    pdfBuffer,
    byteLength: binaryCheck.byteLength,
    pageCount: binaryCheck.pageCount,
    density: chosenDensity,
  };
}
