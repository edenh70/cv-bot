import JSZip from 'jszip';
import type {
  CvLayoutMeta,
  TailorableBlock,
  TailoredCV,
  TailoringDiffMap,
} from './types';

export interface DocxLayoutMeta extends CvLayoutMeta {
  sectionOrder: Array<'experience' | 'education' | 'toolbox'>;
  hasSummaryHeading: boolean;
  accentColor?: string;
  inlineHeaderContact?: boolean;
}

const SKIP_PARAGRAPH_TAG_REGEX =
  /<w:hyperlink\b|<w:drawing\b|<w:pict\b|<mc:AlternateContent\b/;

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function normalizeForMatch(text: string): string {
  return text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractParagraphPlainText(pXml: string): string {
  const parts: string[] = [];
  const tokenRegex =
    /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(pXml)) !== null) {
    if (match[1] !== undefined) {
      parts.push(decodeXmlEntities(match[1]));
    } else {
      parts.push(' ');
    }
  }
  return normalizeForMatch(parts.join(''));
}

function extractRunInfo(
  pXml: string,
): Array<{ rPr: string; text: string }> {
  const runs: Array<{ rPr: string; text: string }> = [];
  const runRegex = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let rMatch: RegExpExecArray | null;
  while ((rMatch = runRegex.exec(pXml)) !== null) {
    const inner = rMatch[1];
    const rPrMatch = inner.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[0] : '';
    const tParts: string[] = [];
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      tParts.push(decodeXmlEntities(tMatch[1]));
    }
    const text = tParts.join('');
    if (text.length > 0) {
      runs.push({ rPr, text });
    }
  }
  return runs;
}

function isValidAccentHex(hex: string): boolean {
  const upper = hex.toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(upper)) return false;
  if (upper === '000000' || upper === 'FFFFFF' || upper === 'AUTO') return false;
  const r = parseInt(upper.slice(0, 2), 16);
  const g = parseInt(upper.slice(2, 4), 16);
  const b = parseInt(upper.slice(4, 6), 16);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread >= 20;
}

export async function validateDocxBinary(
  buffer: Buffer,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  if (!buffer || buffer.length < 4) {
    errors.push('DOCX buffer is empty or truncated.');
    return { valid: false, errors };
  }

  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    errors.push('DOCX buffer does not start with valid PK zip signature.');
    return { valid: false, errors };
  }

  try {
    const zip = await JSZip.loadAsync(buffer);
    const docFile = zip.file('word/document.xml');
    if (!docFile) {
      errors.push('Invalid .docx archive: missing word/document.xml.');
    } else {
      const xml = await docFile.async('string');
      if (!xml.includes('<w:body')) {
        errors.push('Invalid word/document.xml: missing <w:body>.');
      }
    }
  } catch (err) {
    errors.push(
      `Corrupt .docx archive: ${err instanceof Error ? err.message : 'Unable to unzip.'}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

export async function extractDocxInfo(
  buffer: Buffer,
): Promise<{ paragraphs: string[]; layout: DocxLayoutMeta }> {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid .docx file: word/document.xml not found.');
  }

  const xml = await docFile.async('string');
  const pMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
  const paragraphs = pMatches
    .map((p) => extractParagraphPlainText(p))
    .filter((t) => t.length > 0);

  const sectionOrder: Array<'experience' | 'education' | 'toolbox'> = [];
  let hasSummaryHeading = false;

  for (const p of paragraphs) {
    const upper = p.toUpperCase();
    if (/^(PROFESSIONAL\s+SUMMARY|SUMMARY|PROFILE)$/.test(upper)) {
      hasSummaryHeading = true;
    } else if (
      /^(PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)$/.test(upper)
    ) {
      if (!sectionOrder.includes('experience')) sectionOrder.push('experience');
    } else if (/^(EDUCATION|EDUCATION\s*&\s*TRAINING)$/.test(upper)) {
      if (!sectionOrder.includes('education')) sectionOrder.push('education');
    } else if (
      /^(TECHNICAL\s+TOOLBOX|TECHNICAL\s+SKILLS|SKILLS|TOOLBOX)$/.test(upper)
    ) {
      if (!sectionOrder.includes('toolbox')) sectionOrder.push('toolbox');
    }
  }

  for (const sec of ['experience', 'education', 'toolbox'] as const) {
    if (!sectionOrder.includes(sec)) {
      sectionOrder.push(sec);
    }
  }

  const inlineHeaderContact = Boolean(
    paragraphs[1] && paragraphs[1].includes('|') && /@|\d{3}/.test(paragraphs[1]),
  );

  let accentColor: string | undefined;
  const colorMatches = xml.matchAll(/<w:color\b[^>]*w:val="([0-9A-Fa-f]{6})"/g);
  for (const cm of colorMatches) {
    if (isValidAccentHex(cm[1])) {
      accentColor = `#${cm[1].toUpperCase()}`;
      break;
    }
  }

  return {
    paragraphs,
    layout: {
      sectionOrder,
      hasSummaryHeading,
      accentColor,
      inlineHeaderContact,
    },
  };
}

function paragraphMatchesTarget(paragraphText: string, targetText: string): boolean {
  const pNorm = normalizeForMatch(paragraphText);
  const tNorm = normalizeForMatch(targetText);
  if (!pNorm || !tNorm) return false;
  if (pNorm === tNorm) return true;
  if (pNorm.length >= 45 && tNorm.length >= 45) {
    const prefixLen = Math.min(45, pNorm.length, tNorm.length);
    return (
      pNorm.startsWith(tNorm.slice(0, prefixLen)) ||
      tNorm.startsWith(pNorm.slice(0, prefixLen))
    );
  }
  return false;
}

/**
 * Extracts ONLY the exact tailorable XML paragraphs (summary, experience bullets,
 * and toolbox lines) from `word/document.xml`, never headers, contact lines,
 * hyperlinks, companies, dates, or education rows.
 */
export async function extractTailorableBlocksFromDocx(
  originalBuffer: Buffer,
  masterTemplate: TailoredCV,
): Promise<TailorableBlock[]> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid .docx file: word/document.xml not found.');
  }

  const xml = await docFile.async('string');
  const pMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
  const xmlParagraphs: string[] = [];

  for (const pXml of pMatches) {
    if (SKIP_PARAGRAPH_TAG_REGEX.test(pXml)) continue;
    const plain = extractParagraphPlainText(pXml);
    if (plain.length > 0) {
      xmlParagraphs.push(plain);
    }
  }

  const usedIndices = new Set<number>();
  const findXmlParagraph = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      const idx = xmlParagraphs.findIndex(
        (pText, i) => !usedIndices.has(i) && paragraphMatchesTarget(pText, candidate),
      );
      if (idx !== -1) {
        usedIndices.add(idx);
        return xmlParagraphs[idx];
      }
    }
    return null;
  };

  const blocks: TailorableBlock[] = [];

  if (masterTemplate.summary.trim().length > 0) {
    const exactSummary = findXmlParagraph([masterTemplate.summary]);
    if (exactSummary) {
      blocks.push({
        id: 'summary',
        section: 'summary',
        originalText: exactSummary,
        maxLength: exactSummary.length,
      });
    }
  }

  masterTemplate.experience.forEach((role, rIdx) => {
    role.bullets.forEach((bullet, bIdx) => {
      const exactBullet = findXmlParagraph([bullet]);
      if (exactBullet) {
        blocks.push({
          id: `exp_${rIdx}_bullet_${bIdx}`,
          section: 'bullet',
          originalText: exactBullet,
          maxLength: exactBullet.length,
        });
      }
    });
  });

  masterTemplate.toolbox.forEach((tb, tIdx) => {
    const fullRow = `${tb.category}: ${tb.items}`;
    const exactToolbox = findXmlParagraph([fullRow, tb.items]);
    if (exactToolbox) {
      blocks.push({
        id: `toolbox_${tIdx}`,
        section: 'toolbox',
        originalText: exactToolbox,
        maxLength: exactToolbox.length,
      });
    }
  });

  return blocks;
}

/**
 * Validates and sanitizes Gemini's surgical replacements against the allowed
 * tailorable XML blocks. Strictly enforces `tailored_text.length <= original_text.length`
 * and preserves `Category:` prefixes on toolbox rows.
 */
export function sanitizeSurgicalReplacements(
  rawPairs: Array<{ original_text: string; tailored_text: string }>,
  allowedBlocks: TailorableBlock[],
): {
  replacements: TailoringDiffMap;
  droppedTooLong: Array<{ original_text: string; tailored_text: string }>;
} {
  const blockByNorm = new Map<string, TailorableBlock>();
  for (const block of allowedBlocks) {
    blockByNorm.set(normalizeForMatch(block.originalText), block);
  }

  const replacements: TailoringDiffMap = {};
  const droppedTooLong: Array<{ original_text: string; tailored_text: string }> = [];

  for (const pair of rawPairs) {
    const origNorm = normalizeForMatch(pair.original_text ?? '');
    let block = blockByNorm.get(origNorm);

    if (!block && origNorm.length >= 45) {
      block = allowedBlocks.find((b) =>
        paragraphMatchesTarget(b.originalText, origNorm),
      );
    }
    if (!block) continue;

    const canonicalOriginal = normalizeForMatch(block.originalText);
    let tailoredNorm = normalizeForMatch(pair.tailored_text ?? '');
    if (!tailoredNorm || tailoredNorm === canonicalOriginal) continue;

    // Guarantee exact "Category:" prefix stays untouched on toolbox entries
    if (block.section === 'toolbox') {
      const origColon = canonicalOriginal.indexOf(':');
      if (origColon > 0 && origColon < 45) {
        const expectedPrefix = canonicalOriginal.slice(0, origColon + 1);
        if (!tailoredNorm.startsWith(expectedPrefix)) {
          const tColon = tailoredNorm.indexOf(':');
          const itemsPart =
            tColon >= 0 && tColon < 45
              ? tailoredNorm.slice(tColon + 1).trim()
              : tailoredNorm;
          tailoredNorm = `${expectedPrefix} ${itemsPart}`;
        }
      }
    }

    if (tailoredNorm.length > canonicalOriginal.length) {
      droppedTooLong.push({
        original_text: canonicalOriginal,
        tailored_text: tailoredNorm,
      });
      continue;
    }

    replacements[canonicalOriginal] = tailoredNorm;
  }

  return { replacements, droppedTooLong };
}

interface TextReplacement {
  oldNorm: string;
  newText: string;
  used: boolean;
}

function findMatchingReplacement(
  paragraphText: string,
  replacements: TextReplacement[],
): TextReplacement | undefined {
  const norm = normalizeForMatch(paragraphText);
  if (!norm) return undefined;

  const exact = replacements.find((r) => !r.used && r.oldNorm === norm);
  if (exact) return exact;

  if (norm.length >= 45) {
    const prefix = norm.slice(0, 45);
    return replacements.find(
      (r) => !r.used && r.oldNorm.length >= 45 && r.oldNorm.startsWith(prefix),
    );
  }

  return undefined;
}

function rebuildParagraphXml(pXml: string, newText: string): string {
  const openTagMatch = pXml.match(/^<w:p\b[^>]*>/);
  const openTag = openTagMatch ? openTagMatch[0] : '<w:p>';
  const pPrMatch = pXml.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : '';

  const runs = extractRunInfo(pXml);
  const colonIdx = newText.indexOf(':');

  // Preserve bold label + regular body formatting on "Label: Value" rows (e.g. Toolbox)
  if (
    colonIdx > 0 &&
    colonIdx < 45 &&
    runs.length >= 2 &&
    /<w:b\b/.test(runs[0].rPr) &&
    !/<w:b\b/.test(runs[1].rPr) &&
    runs[0].text.includes(':')
  ) {
    const labelPart = newText.slice(0, colonIdx + 1);
    const valuePart = newText.slice(colonIdx + 1);
    return `${openTag}${pPr}<w:r>${runs[0].rPr}<w:t xml:space="preserve">${escapeXml(labelPart)}</w:t></w:r><w:r>${runs[1].rPr}<w:t xml:space="preserve">${escapeXml(valuePart)}</w:t></w:r></w:p>`;
  }

  const primaryRPr = runs[0]?.rPr ?? '';
  return `${openTag}${pPr}<w:r>${primaryRPr}<w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r></w:p>`;
}

/**
 * Patches ONLY matching paragraphs inside `word/document.xml` from `replacements`,
 * leaving all untouched paragraphs, hyperlinks, styles, margins, and borders
 * 100% byte-identical to the uploaded `.docx` template.
 */
export async function patchDocxWithReplacements(
  originalBuffer: Buffer,
  replacementsMap: TailoringDiffMap,
): Promise<{
  docxBuffer: Buffer;
  appliedCount: number;
  appliedMap: TailoringDiffMap;
}> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid .docx archive: missing word/document.xml');
  }

  const xml = await docFile.async('string');
  const queue: TextReplacement[] = Object.entries(replacementsMap)
    .map(([oldStr, newStr]) => ({
      oldNorm: normalizeForMatch(oldStr),
      newText: normalizeForMatch(newStr),
      used: false,
    }))
    .filter((item) => item.oldNorm && item.newText && item.oldNorm !== item.newText);

  let appliedCount = 0;
  const appliedMap: TailoringDiffMap = {};

  const patchedXml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml) => {
    if (SKIP_PARAGRAPH_TAG_REGEX.test(pXml)) {
      return pXml;
    }
    const plain = extractParagraphPlainText(pXml);
    const match = findMatchingReplacement(plain, queue);
    if (!match) {
      return pXml;
    }
    match.used = true;
    appliedCount += 1;
    appliedMap[match.oldNorm] = match.newText;
    return rebuildParagraphXml(pXml, match.newText);
  });

  zip.file('word/document.xml', patchedXml);
  const docxBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  const binaryCheck = await validateDocxBinary(docxBuffer);
  if (!binaryCheck.valid) {
    throw new Error(
      `Generated .docx archive failed validation: ${binaryCheck.errors.join('; ')}`,
    );
  }

  return { docxBuffer, appliedCount, appliedMap };
}

/**
 * Applies a surgical `{ original_text: tailored_text }` replacement map onto a
 * structured Master CV copy while keeping companies, periods, education, and
 * extra sections strictly untouched.
 */
export function applyReplacementsToStructuredCv(
  master: TailoredCV,
  replacementsMap: TailoringDiffMap,
): TailoredCV {
  const entries = Object.entries(replacementsMap).map(([k, v]) => ({
    oldNorm: normalizeForMatch(k),
    newText: normalizeForMatch(v),
  }));

  const lookup = (original: string): string | undefined => {
    const match = entries.find((e) => paragraphMatchesTarget(e.oldNorm, original));
    return match?.newText;
  };

  return {
    ...structuredClone(master),
    summary: lookup(master.summary) ?? master.summary,
    experience: master.experience.map((role) => ({
      ...role,
      bullets: role.bullets.map((b) => lookup(b) ?? b),
    })),
    toolbox: master.toolbox.map((tb) => {
      const fullRow = `${tb.category}: ${tb.items}`;
      const hit = lookup(fullRow) ?? lookup(tb.items);
      if (!hit) return { ...tb };
      const prefix = `${tb.category}:`;
      if (hit.startsWith(prefix)) {
        return { category: tb.category, items: hit.slice(prefix.length).trim() };
      }
      const colonIdx = hit.indexOf(':');
      if (colonIdx > 0 && colonIdx < 45) {
        return {
          category: tb.category,
          items: hit.slice(colonIdx + 1).trim() || tb.items,
        };
      }
      return { category: tb.category, items: hit };
    }),
  };
}

/**
 * Backwards-compatible wrapper for pre-migration jobs that stored only
 * `tailored_cv_json` without `tailoring_diffs_json`.
 */
export async function patchDocxWithTailoredCv(
  originalBuffer: Buffer,
  masterTemplate: TailoredCV,
  tailoredCv: TailoredCV,
): Promise<Buffer> {
  const map: TailoringDiffMap = {};
  const addIfChanged = (oldStr: string | undefined, newStr: string | undefined) => {
    const o = normalizeForMatch(oldStr ?? '');
    const n = normalizeForMatch(newStr ?? '');
    if (o && n && o !== n) {
      map[o] = n;
    }
  };

  addIfChanged(masterTemplate.summary, tailoredCv.summary);
  masterTemplate.experience.forEach((mRole, idx) => {
    const tRole = tailoredCv.experience[idx];
    if (!tRole) return;
    mRole.bullets.forEach((mBullet, bIdx) => {
      addIfChanged(mBullet, tRole.bullets[bIdx]);
    });
  });
  masterTemplate.toolbox.forEach((mCat, idx) => {
    const tCat = tailoredCv.toolbox[idx];
    if (!tCat) return;
    addIfChanged(`${mCat.category}: ${mCat.items}`, `${tCat.category}: ${tCat.items}`);
    addIfChanged(mCat.items, tCat.items);
  });

  const { docxBuffer } = await patchDocxWithReplacements(originalBuffer, map);
  return docxBuffer;
}
