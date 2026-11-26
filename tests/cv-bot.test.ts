import test from 'node:test';
import assert from 'node:assert/strict';
import { CV_LIMITS, sanitizeTailoredCV } from '../lib/cv-schema';
import {
  CV_PDF_BOUNDS,
  CvValidationError,
  validateAndRenderCv,
  validatePdfBinary,
  validateTailoredCvContent,
} from '../lib/cv-validator';
import {
  DEFAULT_GOOGLE_SHEET_URL,
  extractSourcesFromSheetRows,
  parseCsv,
  toGoogleSheetCsvUrl,
} from '../lib/google-sheet';
import { cleanScrapedMarkdown, normalizeAndValidateUrl } from '../lib/jina';
import { getDefaultMasterCvTemplate, MASTER_CV } from '../lib/master-cv';
import type { TailoredCV } from '../lib/types';

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

  for (const exp of sanitized.experience) {
    assert.equal(exp.bullets.length, 3);
    for (const b of exp.bullets) {
      assert.ok(b.length <= CV_LIMITS.BULLET_MAX);
    }
  }
  assert.equal(sanitized.toolbox.length, 4);
  for (const tb of sanitized.toolbox) {
    assert.ok(tb.category.length + 2 + tb.items.length <= CV_LIMITS.TOOLBOX_LINE_MAX);
  }
  assert.ok(sanitized.education.length <= CV_LIMITS.EDUCATION_MAX_LINES);
});

test('validateAndRenderCv produces a valid strictly 1-page PDF from authentic Master CV', async () => {
  const cv = makeValidMasterTailoredCv();
  const result = await validateAndRenderCv(cv, {
    match_score: 9,
    summary_hebrew: 'משרת דאטה אנליסט בצוות מוצר בתל אביב עם דגש על SQL ו-Python.',
    changes_made: '- Emphasized SQL and Python event-stream analytics\n- Highlighted KPI monitoring',
  });

  assert.equal(result.pageCount, 1);
  assert.ok(result.byteLength >= CV_PDF_BOUNDS.MIN_BYTES);
  assert.ok(result.byteLength <= CV_PDF_BOUNDS.MAX_BYTES);
  assert.ok(result.pdfBuffer.toString('latin1').startsWith('%PDF-'));
  assert.ok(result.pdfBuffer.toString('latin1').includes('%%EOF'));
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

test('validatePdfBinary rejects empty buffers, non-PDF bytes, truncated PDFs, and 2-page PDFs', () => {
  assert.equal(validatePdfBinary(Buffer.alloc(0)).valid, false);
  assert.equal(validatePdfBinary(Buffer.from('<html>not a pdf</html>')).valid, false);
  assert.equal(validatePdfBinary(Buffer.from('%PDF-1.4\n/Type /Page\n')).valid, false);

  const twoPageFake = Buffer.from(
    `%PDF-1.4\n${'x'.repeat(3000)}\n/Type /Page\n/Type /Page\n%%EOF`,
    'latin1',
  );
  const resTwoPage = validatePdfBinary(twoPageFake);
  assert.equal(resTwoPage.valid, false);
  assert.equal(resTwoPage.pageCount, 2);
});

test('validateAndRenderCv throws CvValidationError when content has LLM leakage', async () => {
  const cv = makeValidMasterTailoredCv();
  cv.experience[0].bullets[0] = 'Implemented {{metric}} pipeline for TODO client in SQL and Python.';
  await assert.rejects(
    () => validateAndRenderCv(cv),
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
  assert.ok(cleaned.includes('[Big Data Analyst Tel Aviv](https://job-boards.greenhouse.io/similarweb/jobs/6897277)'));

  assert.throws(() => normalizeAndValidateUrl('http://localhost:3000/test'));
  assert.throws(() => normalizeAndValidateUrl('http://192.168.1.1/admin'));
});

test('custom uploaded 4-role CV with extraSections renders strictly 1 page via density scaling and locks employers on tailoring', async () => {
  const customMaster: TailoredCV = {
    name: 'Eden Hadad',
    title: 'Senior Data Analyst & BI Specialist',
    contactLine: 'Tel Aviv, Israel | edenhadad70@gmail.com | 054-9451235',
    summary:
      'Experienced Data Analyst specializing in product funnels, SQL data modeling, Python pipelines, and executive KPI reporting across SaaS and e-commerce.',
    experience: [
      {
        role: 'Data Analyst & AI Solutions',
        company: 'Freelance Consulting',
        period: '2023 – Present',
        bullets: [
          'Built automated KPI pipelines and custom Looker/Tableau executive dashboards for SaaS clients.',
          'Analyzed product event telemetry and cohort retention in Python (Pandas, NumPy) and BigQuery.',
          'Automated data QA workflows using LLM integrations to cut manual reporting overhead by 40%.',
        ],
      },
      {
        role: 'Product Data Analyst',
        company: 'Montara',
        period: '2021 – 2023',
        bullets: [
          'Owned product funnel analytics, A/B experimentation, and feature adoption tracking.',
          'Trained production classification models improving anomaly detection accuracy by 15%.',
          'Partnered with Data Engineering to maintain Airflow and SQL ETL pipelines.',
        ],
      },
      {
        role: 'Data Analyst',
        company: 'Shufersal Digital',
        period: '2020 – 2021',
        bullets: [
          'Queried multi-million-row e-commerce tables using complex SQL Window Functions and CTEs.',
          'Partnered with Marketing and Product VPs on revenue attribution and campaign ROI models.',
        ],
      },
      {
        role: 'Operations Analyst (Intern)',
        company: 'Ben-Gurion Lab',
        period: '2019 – 2020',
        bullets: [
          'Modeled supply-chain throughput bottlenecks using Python and Excel statistical analysis.',
          'Automated weekly KPI status reports for operations leadership.',
        ],
      },
    ],
    toolbox: [
      { category: 'Query & Code', items: 'SQL (BigQuery, PostgreSQL, MySQL), Python (Pandas, NumPy, Scikit-Learn)' },
      { category: 'BI & Experimentation', items: 'Tableau, Power BI, Metabase, A/B Testing, Funnel & Cohort Analysis' },
      { category: 'Data Engineering', items: 'Apache Airflow, PySpark, dbt, Git, Docker' },
    ],
    education: [
      'B.Sc. Industrial Engineering & Management — Ben-Gurion University (2016–2020)',
      'G-Academy — PySpark & Python for Data Science',
    ],
    extraSections: [
      { title: 'Languages', items: ['Hebrew (Native)', 'English (Fluent)'] },
      { title: 'Military Service', items: ['IDF — Full Service, Operations & Analytics Support'] },
    ],
  };

  const rendered = await validateAndRenderCv(customMaster, undefined, {
    preserveUploadedShape: true,
  });
  assert.equal(rendered.pageCount, 1);
  assert.equal(rendered.cv.experience.length, 4);
  assert.equal(rendered.cv.extraSections?.length, 2);

  // Tailored CV trying to tamper with company name must be rejected by custom masterTemplate check
  const tampered = structuredClone(customMaster);
  tampered.experience[1].company = 'Tampered Startup';
  const check = validateTailoredCvContent(tampered, undefined, customMaster);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.includes('does not match Master CV')));
});
