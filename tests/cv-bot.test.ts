import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CV_LIMITS, sanitizeTailoredCV } from '../lib/cv-schema';
import {
  extractDocxInfo,
  extractTailorableBlocksFromDocx,
  patchDocxWithReplacements,
  sanitizeSurgicalReplacements,
} from '../lib/docx-template';
import {
  buildAndValidateTemplateCv,
  CV_PDF_BOUNDS,
  CvValidationError,
  validatePdfBinary,
  validateTailoredCvContent,
} from '../lib/cv-validator';
import {
  DEFAULT_GOOGLE_SHEET_URL,
  extractSourcesFromSheetRows,
  parseCsv,
  toGoogleSheetCsvUrl,
} from '../lib/google-sheet';
import {
  cleanScrapedMarkdown,
  detectBotBlock,
  extractNavigationFromMarkdown,
  htmlToMarkdown,
  normalizeAndValidateUrl,
} from '../lib/jina';
import { prioritizeSourcesByPrompt } from '../lib/pipeline';
import { getDefaultMasterCvTemplate, MASTER_CV } from '../lib/master-cv';
import type { SourceRecord, TailoredCV, TailoringDiffMap } from '../lib/types';

function makeValidMasterTailoredCv(): TailoredCV {
  return {
    summary: MASTER_CV.defaultSummary,
    experience: MASTER_CV.experience.map((e) => ({
      role: e.role,
      company: e.company,
      period: e.period,
      bullets: [...e.bullets] as [string, string, string],
    })) as TailoredCV['experience'],
    toolbox: MASTER_CV.defaultToolbox.map((t) => ({ ...t })) as TailoredCV['toolbox'],
    education: [...MASTER_CV.education],
  };
}

async function makeTestPdfBuffer(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    for (let line = 0; line < 35; line++) {
      page.drawText(
        `Eden Hadad Senior Data Analyst SQL Python BigQuery Line ${line} Page ${i + 1} `.repeat(3),
        { x: 30, y: 800 - line * 20, size: 9, font },
      );
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function makeSampleDocxFixture(): Promise<{
  buffer: Buffer;
  master: TailoredCV;
  summary: string;
  bullet: string;
  toolboxItems: string;
}> {
  const summary =
    'Data Analyst with a B.Sc. in Industrial Engineering and 5+ years of experience driving product optimization and revenue growth.';
  const bullet =
    'Built Tableau/Power BI dashboards, custom analytics tools, and XGBoost churn/LTV models for clients, automating SQL reporting and lifting conversions by up to 18%.';
  const toolboxItems =
    'SQL (PostgreSQL, BigQuery), Excel, Tableau, Power BI, A/B Testing, Statistics.';

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:color w:val="1B4965"/><w:b/></w:rPr><w:t>Eden Hadad</w:t></w:r></w:p>
    <w:p><w:r><w:t>Senior Data Analyst | Giv'atayim, Israel | edenhadad70@gmail.com | </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>LinkedIn</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:r><w:t>${summary}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>PROFESSIONAL EXPERIENCE</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Senior Data &amp; AI Analyst | Independent Consultant | Mar 2023 – Present</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${bullet}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>EDUCATION</w:t></w:r></w:p>
    <w:p><w:r><w:t>B.Sc. Industrial Engineering &amp; Management | Ben-Gurion University (2016–2020)</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>TECHNICAL TOOLBOX</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Analytics &amp; BI:</w:t></w:r><w:r><w:rPr><w:sz w:val="19"/></w:rPr><w:t> ${toolboxItems}</w:t></w:r></w:p>
  </w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file('word/document.xml', docXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const info = await extractDocxInfo(buffer);
  const master: TailoredCV = {
    name: 'Eden Hadad',
    title: 'Senior Data Analyst',
    contactLine: "Giv'atayim, Israel | edenhadad70@gmail.com | LinkedIn",
    summary,
    experience: [
      {
        role: 'Senior Data & AI Analyst',
        company: 'Independent Consultant',
        period: 'Mar 2023 – Present',
        bullets: [bullet],
      },
    ],
    education: [
      'B.Sc. Industrial Engineering & Management | Ben-Gurion University (2016–2020)',
    ],
    toolbox: [{ category: 'Analytics & BI', items: toolboxItems }],
    layout: info.layout,
  };

  return { buffer, master, summary, bullet, toolboxItems };
}

test('sanitizeTailoredCV clamps oversized fields and locks companies & periods to MASTER_CV', () => {
  const longText =
    'Analyzed multi-terabyte product telemetry datasets and constructed resilient predictive pipelines across enterprise cloud clusters with SQL Python Airflow '.repeat(
      4,
    );
  const sanitized = sanitizeTailoredCV({
    summary: longText,
    experience: [1, 2, 3, 4].map((i) => ({
      role: `Very Long Hallucinated Role Title ${i} With Extra Unnecessary Suffix Words`,
      company: `Fake Company ${i}`,
      period: '2099 - 2100',
      bullets: [longText, longText, longText, longText],
    })),
    toolbox: [1, 2, 3, 4, 5].map((i) => ({
      category: `Category Name Number ${i} Too Long`,
      items: longText,
    })),
    education: [longText, longText, longText],
  });

  assert.ok(sanitized.summary.length <= CV_LIMITS.SUMMARY_MAX);
  assert.equal(sanitized.experience.length, 3);
  assert.equal(sanitized.experience[0].company, MASTER_CV.experience[0].company);
  assert.equal(sanitized.experience[1].company, MASTER_CV.experience[1].company);
  assert.equal(sanitized.experience[2].company, MASTER_CV.experience[2].company);
  assert.equal(sanitized.experience[0].period, MASTER_CV.experience[0].period);
});

test('validateTailoredCvContent rejects hallucinated companies, LLM leakage, non-Hebrew summary, and invalid scores', () => {
  const badCompanyCv = makeValidMasterTailoredCv();
  badCompanyCv.experience[1].company = 'Google DeepMind Fake';
  const resCompany = validateTailoredCvContent(
    badCompanyCv,
    undefined,
    getDefaultMasterCvTemplate(),
  );
  assert.equal(resCompany.valid, false);
  assert.ok(resCompany.errors.some((e) => e.includes('does not match Master CV')));

  const leakageCv = makeValidMasterTailoredCv();
  leakageCv.summary =
    'Here is your tailored CV summary for [INSERT COMPANY] with SQL, Python, and Tableau.';
  const resLeak = validateTailoredCvContent(leakageCv);
  assert.equal(resLeak.valid, false);
  assert.ok(resLeak.errors.some((e) => e.includes('leakage')));

  const validCv = makeValidMasterTailoredCv();
  const resBadMeta = validateTailoredCvContent(validCv, {
    match_score: 15,
    summary_hebrew: 'English only without any Hebrew characters at all',
    changes_made: 'ok',
  });
  assert.equal(resBadMeta.valid, false);
  assert.ok(resBadMeta.errors.length >= 3);
});

test('validatePdfBinary uses pdf-lib to verify strictly 1-page PDFs and reject 2-page/corrupt PDFs', async () => {
  assert.equal((await validatePdfBinary(Buffer.alloc(0))).valid, false);
  assert.equal(
    (await validatePdfBinary(Buffer.from('<html>not a pdf</html>'))).valid,
    false,
  );

  const onePagePdf = await makeTestPdfBuffer(1);
  const resOnePage = await validatePdfBinary(onePagePdf);
  assert.equal(resOnePage.valid, true);
  assert.equal(resOnePage.pageCount, 1);

  const twoPagePdf = await makeTestPdfBuffer(2);
  const resTwoPage = await validatePdfBinary(twoPagePdf);
  assert.equal(resTwoPage.valid, false);
  assert.equal(resTwoPage.pageCount, 2);
  assert.ok(resTwoPage.errors.some((e) => e.includes('Exceeded 1 page')));
});

test('extractTailorableBlocksFromDocx excludes headers, hyperlinks, companies, dates, and education', async () => {
  const { buffer, master } = await makeSampleDocxFixture();
  const blocks = await extractTailorableBlocksFromDocx(buffer, master);

  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => b.section),
    ['summary', 'bullet', 'toolbox'],
  );
  const joined = blocks.map((b) => b.originalText).join(' | ');
  assert.equal(joined.includes('Eden Hadad'), false);
  assert.equal(joined.includes('LinkedIn'), false);
  assert.equal(joined.includes('Ben-Gurion'), false);
  assert.equal(joined.includes('Mar 2023'), false);
});

test('sanitizeSurgicalReplacements enforces tailored_text.length <= original_text.length and preserves Category: prefixes', async () => {
  const { buffer, master, summary, toolboxItems } =
    await makeSampleDocxFixture();
  const blocks = await extractTailorableBlocksFromDocx(buffer, master);
  const fullToolbox = `Analytics & BI: ${toolboxItems}`;

  const { replacements, droppedTooLong } = sanitizeSurgicalReplacements(
    [
      {
        original_text: summary,
        tailored_text:
          'Data Analyst with a B.Sc. in Industrial Engineering and 5+ years driving SaaS product funnels and growth.',
      },
      {
        original_text: master.experience[0].bullets[0],
        tailored_text: `${master.experience[0].bullets[0]} Plus 50 extra characters that definitely overflow!`,
      },
      {
        original_text: fullToolbox,
        tailored_text: 'A/B Testing, SQL (PostgreSQL, BigQuery), Tableau.',
      },
    ],
    blocks,
  );

  assert.equal(droppedTooLong.length, 1);
  assert.ok(replacements[summary]);
  assert.ok(replacements[summary].length <= summary.length);
  assert.ok(
    replacements[fullToolbox].startsWith('Analytics & BI: '),
  );
  assert.ok(replacements[fullToolbox].length <= fullToolbox.length);
});

test('patchDocxWithReplacements preserves hyperlinks, bold prefixes, PK zip header, and untouched paragraphs byte-for-byte', async () => {
  const { buffer, master, summary, bullet, toolboxItems } =
    await makeSampleDocxFixture();
  const fullToolbox = `Analytics & BI: ${toolboxItems}`;

  const diffs: TailoringDiffMap = {
    [summary]:
      'Data Analyst with a B.Sc. in Industrial Engineering and 5+ years driving SaaS funnels and growth.',
    [fullToolbox]:
      'Analytics & BI: A/B Testing, SQL (PostgreSQL, BigQuery), Tableau, Power BI.',
  };

  const { docxBuffer, appliedCount } = await patchDocxWithReplacements(
    buffer,
    diffs,
  );
  assert.equal(appliedCount, 2);
  assert.equal(docxBuffer[0], 0x50);
  assert.equal(docxBuffer[1], 0x4b);

  const patchedZip = await JSZip.loadAsync(docxBuffer);
  const patchedXml = await patchedZip.file('word/document.xml')!.async('string');

  assert.ok(patchedXml.includes('<w:hyperlink r:id="rId1">'));
  assert.ok(patchedXml.includes('<w:numId w:val="1"/>'));
  assert.ok(patchedXml.includes('driving SaaS funnels and growth'));
  assert.ok(
    patchedXml.includes(
      '<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Analytics &amp; BI:</w:t>',
    ),
  );

  const mammothText = (await mammoth.extractRawText({ buffer: docxBuffer })).value;
  assert.ok(mammothText.includes(bullet));
  assert.ok(mammothText.includes('B.Sc. Industrial Engineering'));
});

test('buildAndValidateTemplateCv auto-recovers from 2-page PDF on retry and hard-blocks failed_validation if still >1 page', async () => {
  const { buffer, master, summary } = await makeSampleDocxFixture();
  const allowedBlocks = await extractTailorableBlocksFromDocx(buffer, master);
  const onePagePdf = await makeTestPdfBuffer(1);
  const twoPagePdf = await makeTestPdfBuffer(2);

  const initialDiffs: TailoringDiffMap = {
    [summary]:
      'Data Analyst with a B.Sc. in Industrial Engineering and 5+ years of experience driving product growth.',
  };

  // Scenario 1: 2 pages -> auto-shorten retry -> 1 page (passes!)
  let callCount = 0;
  const recovered = await buildAndValidateTemplateCv({
    originalDocxBuffer: buffer,
    masterTemplate: master,
    allowedBlocks,
    replacements: initialDiffs,
    convertDocxToPdfFn: async () => {
      callCount += 1;
      return callCount === 1 ? twoPagePdf : onePagePdf;
    },
    shortenReplacementsFn: async () => ({
      [summary]: 'Data Analyst with 5+ years driving product growth and SQL analytics.',
    }),
  });

  assert.equal(callCount, 2);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'pending_review');
  if (recovered.ok) {
    assert.equal(recovered.pageCount, 1);
    assert.equal(recovered.docxBuffer[0], 0x50);
    assert.ok(recovered.pdfBuffer.subarray(0, 5).toString('latin1').startsWith('%PDF-'));
  }

  // Scenario 2: 2 pages even after retry -> hard block failed_validation
  const blocked = await buildAndValidateTemplateCv({
    originalDocxBuffer: buffer,
    masterTemplate: master,
    allowedBlocks,
    replacements: initialDiffs,
    convertDocxToPdfFn: async () => twoPagePdf,
    shortenReplacementsFn: async () => ({
      [summary]: 'Data Analyst with 5+ years driving product growth.',
    }),
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'failed_validation');
  assert.equal(blocked.validationError, 'Exceeded 1 page');
  assert.equal(blocked.pageCount, 2);
});

test('buildAndValidateTemplateCv throws CvValidationError when replacements contain LLM leakage', async () => {
  const { buffer, master, summary } = await makeSampleDocxFixture();
  const allowedBlocks = await extractTailorableBlocksFromDocx(buffer, master);

  await assert.rejects(
    () =>
      buildAndValidateTemplateCv({
        originalDocxBuffer: buffer,
        masterTemplate: master,
        allowedBlocks,
        replacements: {
          [summary]: 'TODO [INSERT COMPANY] Data Analyst SQL',
        },
        convertDocxToPdfFn: async () => makeTestPdfBuffer(1),
      }),
    (err: unknown) => err instanceof CvValidationError && err.reasons.length > 0,
  );
});

test('Google Sheet parser handles BOM, quoted commas, inactive rows, duplicates, and unsafe URLs', () => {
  assert.equal(
    toGoogleSheetCsvUrl(DEFAULT_GOOGLE_SHEET_URL),
    'https://docs.google.com/spreadsheets/d/1i4-O4tu2GXdPHHcxF8A5SqnwW9xQUoetffVSWYyTBTo/export?format=csv&gid=0',
  );

  const csv = [
    '\uFEFFCompany,URL,Active',
    '"Similarweb, Ltd",https://job-boards.greenhouse.io/similarweb,TRUE',
    'DuplicateSimilarweb,https://job-boards.greenhouse.io/similarweb,TRUE',
    'LocalhostAttack,http://127.0.0.1:8080/careers,TRUE',
    'Wix,https://www.wix.com/jobs,false',
    ',,,',
  ].join('\r\n');

  const extracted = extractSourcesFromSheetRows(parseCsv(csv));
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].name, 'Similarweb, Ltd');
  assert.equal(extracted[0].is_active, true);
  assert.equal(extracted[1].name, 'Wix');
  assert.equal(extracted[1].is_active, false);
});

test('cleanScrapedMarkdown strips tracking pixels while keeping job links, and URL validator blocks private hosts', () => {
  const dirty = [
    '# Jobs',
    '![Image 1](https://analytics.twitter.com/1/i/adsct?foo=bar)',
    '',
    '',
    '',
    '[Big Data Analyst Tel Aviv](https://job-boards.greenhouse.io/similarweb/jobs/6897277)',
  ].join('\n');

  const cleaned = cleanScrapedMarkdown(dirty, 5000);
  assert.equal(cleaned.includes('analytics.twitter.com'), false);
  assert.ok(
    cleaned.includes(
      '[Big Data Analyst Tel Aviv](https://job-boards.greenhouse.io/similarweb/jobs/6897277)',
    ),
  );

  assert.throws(() => normalizeAndValidateUrl('http://localhost:3000/test'));
  assert.throws(() => normalizeAndValidateUrl('http://192.168.1.1/admin'));
});

test('extractNavigationFromMarkdown switches Next/?page=2 URLs beyond 45k chars and flags JS-only # pagination', () => {
  const longPaddedMarkdown = [
    '# Israel Jobs',
    'x '.repeat(26000),
    '[Sr Data Analyst](https://jobs.paloaltonetworks.com/en/job/tel-aviv/sr-data-analyst/47263/101)',
    '[Next](https://jobs.paloaltonetworks.com/en/location/israel-jobs/47263/294640/2/2)',
  ].join('\n');

  // Truncated markdown keeps both head & tail via cleanScrapedMarkdown
  const truncatedForLlm = cleanScrapedMarkdown(longPaddedMarkdown, 45000);
  assert.ok(truncatedForLlm.includes('sr-data-analyst'));

  const navPage1 = extractNavigationFromMarkdown(
    longPaddedMarkdown,
    'https://jobs.paloaltonetworks.com/en/location/israel-jobs/47263/294640/2',
  );
  assert.equal(
    navPage1.nextPageUrl,
    'https://jobs.paloaltonetworks.com/en/location/israel-jobs/47263/294640/2/2',
  );
  assert.equal(navPage1.hasJsOnlyPagination, false);

  const navPage2 = extractNavigationFromMarkdown(
    '[Next](https://jobs.paloaltonetworks.com/en/location/israel-jobs/47263/294640/2/3)',
    'https://jobs.paloaltonetworks.com/en/location/israel-jobs/47263/294640/2/2',
  );
  assert.equal(
    navPage2.nextPageUrl,
    'https://jobs.paloaltonetworks.com/en/location/israel-jobs/47263/294640/2/3',
  );

  // JS-only # pagination (like Phoenix Nuxt button pagination) must NOT loop on #
  const jsNav = extractNavigationFromMarkdown(
    '[2](https://www.fnx.co.il/career/open-positions/#)\n[הבא](https://www.fnx.co.il/career/open-positions/#)',
    'https://www.fnx.co.il/career/open-positions/',
  );
  assert.equal(jsNav.nextPageUrl, null);
  assert.equal(jsNav.hasJsOnlyPagination, true);

  // Homepage -> external ATS board discovery
  const atsNav = extractNavigationFromMarkdown(
    'We are hiring! [See open roles](https://job-boards.greenhouse.io/exampleco)',
    'https://exampleco.com/',
  );
  assert.equal(atsNav.subpageCareerUrl, 'https://job-boards.greenhouse.io/exampleco');
});

test('detectBotBlock catches Cloudflare WAF walls while passing real job boards', () => {
  const cfBlock = [
    '# Sorry, you have been blocked',
    'Cloudflare Ray ID: a6091b9c9cdfc93f',
    '[Cloudflare](https://www.cloudflare.com/5xx-error-landing)',
  ].join('\n');
  assert.equal(detectBotBlock(cfBlock), 'Blocked by Cloudflare WAF');

  const normalBoard = `${'[Data Analyst](https://jobs.example.com/1)\n'.repeat(10)}Cloudflare security footer`;
  assert.equal(detectBotBlock(normalBoard), null);
});

test('prioritizeSourcesByPrompt boosts traditional sector sources for "low tech" and avoids high-tech false positives', () => {
  const mkSource = (name: string, url: string): SourceRecord => ({
    id: name,
    name,
    url,
    is_active: true,
    last_scanned_at: null,
    created_at: new Date().toISOString(),
  });

  const input = [
    mkSource('דיאלוג (Dialog)', 'https://www.dialog.co.il/high-tech/jobs'),
    mkSource('Innovid', 'https://jobs.techaviv.com/jobs/innovid'),
    mkSource('הפניקס', 'https://www.fnx.co.il/career/open-positions/'),
    mkSource('בנק לאומי', 'https://www.drushim.co.il/jobs/23181'),
  ];

  const ordered = prioritizeSourcesByPrompt(input, 'low tech');
  assert.ok(
    ['הפניקס', 'בנק לאומי'].includes(ordered[0].name) &&
      ['הפניקס', 'בנק לאומי'].includes(ordered[1].name),
  );
});

test('htmlToMarkdown converts anchors cleanly, strips scripts, and preserves Next pagination links', () => {
  const html = `<!doctype html><html><head><title>Jobs</title><script>var x=1;</script></head><body>
    <h1>הראל ביטוח &amp; פיננסים</h1>
    <div class="job"><a href="/jobs/data-analyst-101">Senior Data Analyst</a></div>
    <nav><a href="?page=2">הבא</a></nav>
  </body></html>`;
  const md = htmlToMarkdown(html, 'https://tech.harel-group.co.il/');
  assert.equal(md.includes('var x=1'), false);
  assert.ok(md.includes('הראל ביטוח & פיננסים'));
  assert.ok(md.includes('[Senior Data Analyst](https://tech.harel-group.co.il/jobs/data-analyst-101)'));
  assert.ok(md.includes('[הבא](https://tech.harel-group.co.il/?page=2)'));
});
