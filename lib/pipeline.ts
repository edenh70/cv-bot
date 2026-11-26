import { buildAndValidateTemplateCv } from './cv-validator';
import { extractTailorableBlocksFromDocx } from './docx-template';
import { analyzeAndTailorJob, extractMatchingJobs } from './gemini';
import { syncSourcesFromGoogleSheet } from './google-sheet';
import {
  normalizeAndValidateUrl,
  scrapePageWithJina,
  scrapeUrlWithJina,
} from './jina';
import { getActiveMasterCv } from './master-cv-store';
import { getSupabaseAdmin, JOB_PUBLIC_COLUMNS } from './supabase';
import type {
  JobRecord,
  ScannedSourceReport,
  ScanResultSummary,
  SourceRecord,
  TailoredCV,
} from './types';

interface PendingCandidate {
  sourceId: string;
  company: string;
  title: string;
  url: string;
}

export interface ScanOptions {
  maxNewJobs?: number;
  maxSources?: number;
  maxPagesPerSource?: number;
  customPrompt?: string;
}

const PROMPT_STOPWORDS = new Set([
  'tech',
  'high',
  'low',
  'jobs',
  'job',
  'careers',
  'career',
  'data',
  'analyst',
  'analysts',
  'israel',
  'company',
  'companies',
  'with',
  'only',
  'focus',
  'find',
  'roles',
  'role',
  'open',
  'from',
  'for',
  'the',
  'and',
  'tel',
  'aviv',
]);

const TRADITIONAL_SECTOR_REGEX =
  /(בנק|ביטוח|פניקס|מנורה|הראל|לאומי|מזרחי|פועלים|דיסקונט|פלאפון|סלקום|אלביט|חילן|שופרסל|א\.מ\.ת|מסטרקארד|אגמטיקס|fnx\.co\.il|menoramivt|harel-group|mizrahi|leumi|cellcom|elbit|hilan|mastercard|icl-group)/i;

const LOW_TECH_PROMPT_REGEX =
  /(\blow[\s-]?tech\b|לואו[\s-]?טק|traditional|banks?|banking|insurance|finance|telecom|בנק|ביטוח|פיננס|תקשורת)/i;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function prioritizeSourcesByPrompt(
  sources: SourceRecord[],
  customPrompt?: string,
): SourceRecord[] {
  if (!customPrompt || !customPrompt.trim()) {
    return sources;
  }

  const normalizedPrompt = customPrompt.toLowerCase();
  const wantsTraditional = LOW_TECH_PROMPT_REGEX.test(normalizedPrompt);
  const tokens = normalizedPrompt
    .split(/[\s,;:|/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !PROMPT_STOPWORDS.has(t));

  const scoreSource = (source: SourceRecord): number => {
    const nameLower = source.name.toLowerCase();
    let hostLower = '';
    try {
      hostLower = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      hostLower = source.url.toLowerCase();
    }

    if (normalizedPrompt.includes(nameLower)) return 3;
    if (wantsTraditional && TRADITIONAL_SECTOR_REGEX.test(`${source.name} ${source.url}`)) {
      return 2;
    }
    for (const token of tokens) {
      if (nameLower.includes(token) || hostLower.includes(token)) {
        return 1;
      }
    }
    return 0;
  };

  return [...sources].sort((a, b) => scoreSource(b) - scoreSource(a));
}

export async function analyzeSingleJobUrl(
  rawUrl: string,
  options?: {
    sourceId?: string | null;
    companyHint?: string;
    titleHint?: string;
    customPrompt?: string;
    masterTemplate?: TailoredCV;
    originalDocxBuffer?: Buffer;
  },
): Promise<{ job: JobRecord; alreadyExisted: boolean }> {
  const url = normalizeAndValidateUrl(rawUrl);
  const supabase = getSupabaseAdmin();

  const { data: existing, error: lookupError } = await supabase
    .from('jobs')
    .select(JOB_PUBLIC_COLUMNS)
    .eq('url', url)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Database lookup failed: ${lookupError.message}`);
  }

  if (existing) {
    return { job: existing as JobRecord, alreadyExisted: true };
  }

  let masterTemplate = options?.masterTemplate;
  let originalDocxBuffer = options?.originalDocxBuffer;

  if (!masterTemplate || !originalDocxBuffer) {
    const active = await getActiveMasterCv();
    masterTemplate = masterTemplate ?? active.template;
    if (!originalDocxBuffer && active.profile?.original_file_base64) {
      originalDocxBuffer = Buffer.from(active.profile.original_file_base64, 'base64');
    }
  }

  if (!originalDocxBuffer) {
    throw new Error(
      'Upload your .docx Master CV template in the Add & Sources tab first so the bot can edit your exact CV in-place.',
    );
  }

  const allowedBlocks = await extractTailorableBlocksFromDocx(
    originalDocxBuffer,
    masterTemplate,
  );
  if (allowedBlocks.length === 0) {
    throw new Error(
      'Could not match tailorable sections inside the uploaded .docx XML. Re-upload your .docx CV in Add & Sources.',
    );
  }

  const markdown = await scrapeUrlWithJina(url);
  const analysis = await analyzeAndTailorJob(url, markdown, {
    company: options?.companyHint,
    title: options?.titleHint,
    customPrompt: options?.customPrompt,
    masterTemplate,
    tailorableBlocks: allowedBlocks,
  });

  const built = await buildAndValidateTemplateCv({
    originalDocxBuffer,
    masterTemplate,
    allowedBlocks,
    replacements: analysis.replacements,
    meta: {
      match_score: analysis.match_score,
      summary_hebrew: analysis.summary_hebrew,
      changes_made: analysis.changes_made,
    },
  });

  const insertPayload: {
    source_id: string | null;
    company: string;
    title: string;
    url: string;
    match_score: number;
    summary_hebrew: string;
    changes_made: string;
    tailored_cv_json: TailoredCV;
    tailoring_diffs_json: Record<string, string>;
    tailored_docx_base64: string | null;
    tailored_pdf_base64: string | null;
    status: 'pending_review' | 'failed_validation';
    validation_error: string | null;
  } = built.ok
    ? {
        source_id: options?.sourceId ?? null,
        company: analysis.company,
        title: analysis.title,
        url,
        match_score: analysis.match_score,
        summary_hebrew: analysis.summary_hebrew,
        changes_made: analysis.changes_made,
        tailored_cv_json: built.cv,
        tailoring_diffs_json: built.replacements,
        tailored_docx_base64: built.docxBuffer.toString('base64'),
        tailored_pdf_base64: built.pdfBuffer.toString('base64'),
        status: 'pending_review',
        validation_error: null,
      }
    : {
        source_id: options?.sourceId ?? null,
        company: analysis.company,
        title: analysis.title,
        url,
        match_score: analysis.match_score,
        summary_hebrew: analysis.summary_hebrew,
        changes_made: analysis.changes_made,
        tailored_cv_json: built.cv,
        tailoring_diffs_json: built.replacements,
        tailored_docx_base64: null,
        tailored_pdf_base64: null,
        status: 'failed_validation',
        validation_error: built.validationError,
      };

  const { data: inserted, error: insertError } = await supabase
    .from('jobs')
    .insert(insertPayload)
    .select(JOB_PUBLIC_COLUMNS)
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced } = await supabase
        .from('jobs')
        .select(JOB_PUBLIC_COLUMNS)
        .eq('url', url)
        .single();
      if (raced) {
        return { job: raced as JobRecord, alreadyExisted: true };
      }
    }
    throw new Error(`Failed to store job: ${insertError.message}`);
  }

  return { job: inserted as JobRecord, alreadyExisted: false };
}

export async function runDailyScan(
  options: ScanOptions | number = {},
): Promise<ScanResultSummary> {
  const opts: ScanOptions =
    typeof options === 'number' ? { maxNewJobs: options } : options;

  const maxNewJobs = clamp(opts.maxNewJobs ?? 3, 1, 5);
  const maxSources = clamp(opts.maxSources ?? 8, 1, 15);
  const maxPagesPerSource = clamp(opts.maxPagesPerSource ?? 3, 1, 3);
  const customPrompt = opts.customPrompt?.trim() || undefined;
  const startedAt = Date.now();
  const timeBudgetMs = 70_000;

  const supabase = getSupabaseAdmin();
  const syncErrors: string[] = [];

  try {
    await syncSourcesFromGoogleSheet();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Google Sheet sync failed';
    console.warn('[cron/scan] Google Sheet sync warning:', msg);
    syncErrors.push(`Google Sheet sync: ${msg}`);
  }

  const { data: sourcesData, error: sourcesError } = await supabase
    .from('sources')
    .select('*')
    .eq('is_active', true)
    .order('last_scanned_at', { ascending: true, nullsFirst: true });

  if (sourcesError) {
    throw new Error(`Failed to load sources: ${sourcesError.message}`);
  }

  const orderedSources = prioritizeSourcesByPrompt(
    (sourcesData ?? []) as SourceRecord[],
    customPrompt,
  );

  const { data: existingUrlsData, error: urlsError } = await supabase
    .from('jobs')
    .select('url');

  if (urlsError) {
    throw new Error(`Failed to load existing job URLs: ${urlsError.message}`);
  }

  const knownUrls = new Set<string>(
    (existingUrlsData ?? []).map((row: { url: string }) => row.url),
  );

  const summary: ScanResultSummary = {
    sourcesScanned: 0,
    pagesCrawled: 0,
    candidatesFound: 0,
    jobsAdded: 0,
    jobsSkipped: 0,
    errors: [...syncErrors],
    jobs: [],
    scannedSources: [],
  };

  const reportBySourceId = new Map<string, ScannedSourceReport>();
  const toProcess: PendingCandidate[] = [];

  for (const source of orderedSources) {
    if (
      toProcess.length >= maxNewJobs ||
      summary.sourcesScanned >= maxSources ||
      Date.now() - startedAt > timeBudgetMs
    ) {
      break;
    }

    summary.sourcesScanned += 1;
    const sourceReport: ScannedSourceReport = {
      sourceId: source.id,
      name: source.name,
      url: source.url,
      status: 'no_matches',
      pagesCrawled: 0,
      pagesVisited: [],
      paginationStatus: 'single_page',
      candidatesFound: 0,
      jobsAdded: 0,
      jobsSkipped: 0,
    };
    summary.scannedSources.push(sourceReport);
    reportBySourceId.set(source.id, sourceReport);

    try {
      const visitedPages = new Set<string>();
      let currentPageUrl: string | null = source.url;
      let pendingPaginationMode: 'switched_pages' | 'followed_subpage' | null = null;

      for (let pageIdx = 0; pageIdx < maxPagesPerSource; pageIdx++) {
        if (
          !currentPageUrl ||
          visitedPages.has(currentPageUrl) ||
          toProcess.length >= maxNewJobs ||
          Date.now() - startedAt > timeBudgetMs
        ) {
          break;
        }

        if (pageIdx > 0 && pendingPaginationMode) {
          sourceReport.paginationStatus = pendingPaginationMode;
        }

        visitedPages.add(currentPageUrl);
        sourceReport.pagesVisited.push(currentPageUrl);

        const scraped = await scrapePageWithJina(currentPageUrl, 45000);
        summary.pagesCrawled += 1;
        sourceReport.pagesCrawled += 1;

        if (scraped.blockedReason) {
          sourceReport.status = 'blocked';
          sourceReport.paginationStatus = 'unknown';
          sourceReport.note = scraped.blockedReason;
          summary.errors.push(`${source.name}: ${scraped.blockedReason}`);
          break;
        }

        const extraction = await extractMatchingJobs(
          source.name,
          currentPageUrl,
          scraped.markdown,
          customPrompt,
        );

        for (const candidate of extraction.jobs) {
          summary.candidatesFound += 1;
          sourceReport.candidatesFound += 1;
          sourceReport.status = 'matched';

          if (knownUrls.has(candidate.url)) {
            summary.jobsSkipped += 1;
            sourceReport.jobsSkipped += 1;
            continue;
          }
          knownUrls.add(candidate.url);
          toProcess.push({
            sourceId: source.id,
            company: candidate.company,
            title: candidate.title,
            url: candidate.url,
          });
          if (toProcess.length >= maxNewJobs) {
            break;
          }
        }

        // Page switching priority: deterministic next-page URL -> Gemini nextPageUrl -> subpage/ATS on page 1
        let nextUrl: string | null = null;
        pendingPaginationMode = null;
        if (scraped.nextPageUrl && !visitedPages.has(scraped.nextPageUrl)) {
          nextUrl = scraped.nextPageUrl;
          pendingPaginationMode = 'switched_pages';
        } else if (
          extraction.nextPageUrl &&
          !visitedPages.has(extraction.nextPageUrl)
        ) {
          nextUrl = extraction.nextPageUrl;
          pendingPaginationMode = 'switched_pages';
        } else if (
          pageIdx === 0 &&
          extraction.jobs.length === 0 &&
          scraped.subpageCareerUrl &&
          !visitedPages.has(scraped.subpageCareerUrl)
        ) {
          nextUrl = scraped.subpageCareerUrl;
          pendingPaginationMode = 'followed_subpage';
        } else if (scraped.hasJsOnlyPagination && sourceReport.pagesVisited.length === 1) {
          sourceReport.paginationStatus = 'js_only';
          sourceReport.note =
            sourceReport.note || 'Page 1 only (JS button pagination)';
        }

        currentPageUrl = nextUrl;
      }

      if (sourceReport.pagesCrawled > 1 && !sourceReport.note) {
        sourceReport.note =
          sourceReport.paginationStatus === 'followed_subpage'
            ? `Followed careers link (${sourceReport.pagesCrawled} pages)`
            : `Switched ${sourceReport.pagesCrawled} pages`;
      }

      await supabase
        .from('sources')
        .update({ last_scanned_at: new Date().toISOString() })
        .eq('id', source.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown scan error';
      console.error(`[cron/scan] Source "${source.name}" error:`, err);
      sourceReport.status = 'error';
      sourceReport.paginationStatus = 'unknown';
      sourceReport.note = msg;
      summary.errors.push(`${source.name}: ${msg}`);

      // Advance last_scanned_at so failing sites don't block the front of the queue on repeat scans
      await supabase
        .from('sources')
        .update({ last_scanned_at: new Date().toISOString() })
        .eq('id', source.id);
    }
  }

  if (toProcess.length > 0) {
    const { template: activeMasterTemplate, profile } = await getActiveMasterCv();
    const originalDocxBuffer = profile?.original_file_base64
      ? Buffer.from(profile.original_file_base64, 'base64')
      : undefined;

    const settled = await Promise.allSettled(
      toProcess.map((candidate) =>
        analyzeSingleJobUrl(candidate.url, {
          sourceId: candidate.sourceId,
          companyHint: candidate.company,
          titleHint: candidate.title,
          customPrompt,
          masterTemplate: activeMasterTemplate,
          originalDocxBuffer,
        }),
      ),
    );

    settled.forEach((result, idx) => {
      const candidate = toProcess[idx];
      const sourceReport = reportBySourceId.get(candidate.sourceId);

      if (result.status === 'fulfilled') {
        if (result.value.alreadyExisted) {
          summary.jobsSkipped += 1;
          if (sourceReport) sourceReport.jobsSkipped += 1;
        } else {
          summary.jobsAdded += 1;
          summary.jobs.push(result.value.job);
          if (sourceReport) {
            sourceReport.jobsAdded += 1;
            sourceReport.status = 'matched';
          }
        }
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : 'Failed to analyze job';
        console.error(`[cron/scan] Job "${candidate.url}" error:`, result.reason);
        summary.errors.push(`${candidate.title}: ${msg}`);
        if (sourceReport) {
          sourceReport.note = `Match found (${candidate.title}), CV failed: ${msg}`;
        }
      }
    });
  }

  return summary;
}
