import { PDFDocument } from 'pdf-lib';
import { CV_LIMITS, sanitizeTailoredCV } from './cv-schema';
import {
  applyReplacementsToStructuredCv,
  normalizeForMatch,
  patchDocxWithReplacements,
  validateDocxBinary,
} from './docx-template';
import { convertDocxToPdf, type DocxToPdfConverter } from './docx-to-pdf';
import { shortenSurgicalReplacements } from './gemini';
import type { TailorableBlock, TailoredCV, TailoringDiffMap } from './types';

export const CV_PDF_BOUNDS = {
  MIN_BYTES: 2_500,
  MAX_BYTES: 5 * 1024 * 1024,
  REQUIRED_PAGES: 1,
} as const;

export const LEAKAGE_PATTERN =
  /\[INSERT|TODO\b|FIXME\b|\bTBD\b|Lorem ipsum|As an AI|Here is your|```|\{\{|\}\}|\bundefined\b|\bNaN\b/i;

const HEBREW_CHAR_PATTERN = /[\u0590-\u05FF]/;

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

/**
 * Counts actual PDF pages programmatically using `pdf-lib`.
 */
export async function countPdfPages(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

export async function validatePdfBinary(
  buffer: Buffer,
): Promise<PdfBinaryValidationResult> {
  const errors: string[] = [];
  const byteLength = buffer.length;

  if (byteLength === 0) {
    errors.push('PDF buffer is empty.');
    return { valid: false, byteLength, pageCount: 0, errors };
  }

  const header = buffer.subarray(0, 8).toString('latin1');
  if (!header.startsWith('%PDF-')) {
    errors.push('PDF buffer does not start with valid %PDF- magic header.');
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

  let pageCount = 0;
  try {
    pageCount = await countPdfPages(buffer);
    if (pageCount !== CV_PDF_BOUNDS.REQUIRED_PAGES) {
      errors.push(
        `Exceeded 1 page: PDF has ${pageCount} page(s), strictly required ${CV_PDF_BOUNDS.REQUIRED_PAGES}.`,
      );
    }
  } catch (err) {
    errors.push(
      `Failed to parse PDF structure with pdf-lib: ${
        err instanceof Error ? err.message : 'Corrupt PDF'
      }`,
    );
  }

  return {
    valid: errors.length === 0,
    byteLength,
    pageCount,
    errors,
  };
}

export function validateReplacementsAgainstRules(
  replacements: TailoringDiffMap,
  allowedBlocks: TailorableBlock[],
): CvContentValidationResult {
  const errors: string[] = [];
  const blockByNorm = new Map(
    allowedBlocks.map((b) => [normalizeForMatch(b.originalText), b]),
  );

  for (const [origKey, newVal] of Object.entries(replacements)) {
    const origNorm = normalizeForMatch(origKey);
    const valNorm = normalizeForMatch(newVal);
    const block = blockByNorm.get(origNorm);

    if (!block) {
      errors.push(
        `Attempted replacement on non-tailorable block: "${origNorm.slice(0, 60)}...".`,
      );
      continue;
    }

    if (valNorm.length > origNorm.length) {
      errors.push(
        `Replacement for ${block.id} (${valNorm.length} chars) exceeds original length (${origNorm.length} chars).`,
      );
    }

    const leakageMatch = valNorm.match(LEAKAGE_PATTERN);
    if (leakageMatch) {
      errors.push(
        `Disallowed placeholder or LLM leakage detected in replacement: "${leakageMatch[0]}".`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
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

export type BuildTemplateCvResult =
  | {
      ok: true;
      status: 'pending_review';
      validationError: null;
      pageCount: 1;
      byteLength: number;
      docxBuffer: Buffer;
      pdfBuffer: Buffer;
      cv: TailoredCV;
      replacements: TailoringDiffMap;
    }
  | {
      ok: false;
      status: 'failed_validation';
      validationError: string;
      pageCount: number;
      cv: TailoredCV;
      replacements: TailoringDiffMap;
    };

/**
 * End-to-end template-preserving CV builder & guardrail:
 * 1. Validates replacement lengths (`<= original`) & zero LLM leakage.
 * 2. Patches the original `.docx` XML in-place (`PK` check).
 * 3. Converts that exact `.docx` to `.pdf` via the pixel-exact converter.
 * 4. Checks page count programmatically with `pdf-lib`.
 * 5. If `pageCount > 1`, triggers ONE automatic Gemini shortening pass (~15-20%)
 *    on the longest modified bullets, re-patches, re-converts, and re-verifies.
 * 6. If still `pageCount !== 1`, hard-blocks as `failed_validation` (`"Exceeded 1 page"`).
 */
export async function buildAndValidateTemplateCv(params: {
  originalDocxBuffer: Buffer;
  masterTemplate: TailoredCV;
  allowedBlocks: TailorableBlock[];
  replacements: TailoringDiffMap;
  meta?: ValidatedCvMetadata;
  convertDocxToPdfFn?: DocxToPdfConverter;
  shortenReplacementsFn?: (current: TailoringDiffMap) => Promise<TailoringDiffMap>;
}): Promise<BuildTemplateCvResult> {
  const {
    originalDocxBuffer,
    masterTemplate,
    allowedBlocks,
    meta,
    convertDocxToPdfFn = convertDocxToPdf,
  } = params;

  const shortenFn =
    params.shortenReplacementsFn ??
    ((current: TailoringDiffMap) =>
      shortenSurgicalReplacements({
        replacements: current,
        allowedBlocks,
        targetReductionRatio: 0.82,
      }));

  let currentReplacements = { ...params.replacements };

  const diffCheck = validateReplacementsAgainstRules(
    currentReplacements,
    allowedBlocks,
  );
  if (!diffCheck.valid) {
    throw new CvValidationError(diffCheck.errors);
  }

  let currentCv = sanitizeTailoredCV(
    applyReplacementsToStructuredCv(masterTemplate, currentReplacements),
    masterTemplate,
  );

  const contentCheck = validateTailoredCvContent(currentCv, meta, masterTemplate);
  if (!contentCheck.valid) {
    throw new CvValidationError(contentCheck.errors);
  }

  const origDocxCheck = await validateDocxBinary(originalDocxBuffer);
  if (!origDocxCheck.valid) {
    throw new CvValidationError(origDocxCheck.errors);
  }

  // Pass 1: patch original .docx -> convert to pixel-exact .pdf -> verify pageCount === 1
  let { docxBuffer } = await patchDocxWithReplacements(
    originalDocxBuffer,
    currentReplacements,
  );
  let pdfBuffer: Buffer = await convertDocxToPdfFn(docxBuffer, 'cv_tailored.docx');
  let pdfCheck = await validatePdfBinary(pdfBuffer);

  if (pdfCheck.valid && pdfCheck.pageCount === 1) {
    return {
      ok: true,
      status: 'pending_review',
      validationError: null,
      pageCount: 1,
      byteLength: pdfCheck.byteLength,
      docxBuffer,
      pdfBuffer,
      cv: currentCv,
      replacements: currentReplacements,
    };
  }

  // Pass 2 (Auto-Recovery Loop): shorten longest modified bullets by ~15-20% if > 1 page
  if (pdfCheck.pageCount > CV_PDF_BOUNDS.REQUIRED_PAGES && Object.keys(currentReplacements).length > 0) {
    currentReplacements = await shortenFn(currentReplacements);
    const retryDiffCheck = validateReplacementsAgainstRules(
      currentReplacements,
      allowedBlocks,
    );
    if (!retryDiffCheck.valid) {
      throw new CvValidationError(retryDiffCheck.errors);
    }

    currentCv = sanitizeTailoredCV(
      applyReplacementsToStructuredCv(masterTemplate, currentReplacements),
      masterTemplate,
    );

    const patchedRetry = await patchDocxWithReplacements(
      originalDocxBuffer,
      currentReplacements,
    );
    docxBuffer = patchedRetry.docxBuffer;
    pdfBuffer = await convertDocxToPdfFn(docxBuffer, 'cv_tailored.docx');
    pdfCheck = await validatePdfBinary(pdfBuffer);

    if (pdfCheck.valid && pdfCheck.pageCount === 1) {
      return {
        ok: true,
        status: 'pending_review',
        validationError: null,
        pageCount: 1,
        byteLength: pdfCheck.byteLength,
        docxBuffer,
        pdfBuffer,
        cv: currentCv,
        replacements: currentReplacements,
      };
    }
  }

  // Hard Block when PDF fails 1-page requirement after recovery retry
  if (pdfCheck.pageCount !== CV_PDF_BOUNDS.REQUIRED_PAGES) {
    return {
      ok: false,
      status: 'failed_validation',
      validationError: 'Exceeded 1 page',
      pageCount: pdfCheck.pageCount,
      cv: currentCv,
      replacements: currentReplacements,
    };
  }

  throw new CvValidationError(pdfCheck.errors);
}
