import JSZip from 'jszip';
import type { CvLayoutMeta, TailoredCV } from './types';

export interface DocxLayoutMeta extends CvLayoutMeta {
  sectionOrder: Array<'experience' | 'education' | 'toolbox'>;
  hasSummaryHeading: boolean;
  accentColor?: string;
  inlineHeaderContact?: boolean;
}

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

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractParagraphPlainText(pXml: string): string {
  const parts: string[] = [];
  const tokenRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
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
  // Skip near-neutral grays/blacks so we pick the actual accent color (e.g. navy/blue)
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread >= 20;
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
    } else if (/^(PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)$/.test(upper)) {
      if (!sectionOrder.includes('experience')) sectionOrder.push('experience');
    } else if (/^(EDUCATION|EDUCATION\s*&\s*TRAINING)$/.test(upper)) {
      if (!sectionOrder.includes('education')) sectionOrder.push('education');
    } else if (/^(TECHNICAL\s+TOOLBOX|TECHNICAL\s+SKILLS|SKILLS|TOOLBOX)$/.test(upper)) {
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

interface TextReplacement {
  oldNorm: string;
  newText: string;
  used: boolean;
}

function buildSurgicalReplacements(
  master: TailoredCV,
  tailored: TailoredCV,
): TextReplacement[] {
  const list: TextReplacement[] = [];

  const pushIfChanged = (oldStr: string | undefined, newStr: string | undefined) => {
    const o = normalizeForMatch(oldStr ?? '');
    const n = normalizeForMatch(newStr ?? '');
    if (o && n && o !== n) {
      list.push({ oldNorm: o, newText: n, used: false });
    }
  };

  pushIfChanged(master.summary, tailored.summary);

  master.experience.forEach((mRole, idx) => {
    const tRole = tailored.experience[idx];
    if (!tRole) return;
    mRole.bullets.forEach((mBullet, bIdx) => {
      pushIfChanged(mBullet, tRole.bullets[bIdx]);
    });
  });

  master.toolbox.forEach((mCat, idx) => {
    const tCat = tailored.toolbox[idx];
    if (!tCat) return;
    const oldFull = `${mCat.category}: ${mCat.items}`;
    const newFull = `${tCat.category}: ${tCat.items}`;
    pushIfChanged(oldFull, newFull);
    pushIfChanged(mCat.items, tCat.items);
  });

  return list;
}

function findMatchingReplacement(
  paragraphText: string,
  replacements: TextReplacement[],
): TextReplacement | undefined {
  const norm = normalizeForMatch(paragraphText);
  if (!norm) return undefined;

  const exact = replacements.find((r) => !r.used && r.oldNorm === norm);
  if (exact) return exact;

  // Fallback prefix match (>= 45 chars) in case Word split punctuation or Master CV had slight whitespace diff
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

export async function patchDocxWithTailoredCv(
  originalBuffer: Buffer,
  masterTemplate: TailoredCV,
  tailoredCv: TailoredCV,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid .docx archive: missing word/document.xml');
  }

  const xml = await docFile.async('string');
  const replacements = buildSurgicalReplacements(masterTemplate, tailoredCv);

  const patchedXml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml) => {
    if (pXml.includes('<w:hyperlink')) {
      return pXml;
    }
    const plain = extractParagraphPlainText(pXml);
    const match = findMatchingReplacement(plain, replacements);
    if (!match) {
      return pXml;
    }
    match.used = true;
    return rebuildParagraphXml(pXml, match.newText);
  });

  zip.file('word/document.xml', patchedXml);
  const output = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  if (output.length < 4 || output[0] !== 0x50 || output[1] !== 0x4b) {
    throw new Error('Generated .docx archive failed ZIP signature check.');
  }

  return output;
}
