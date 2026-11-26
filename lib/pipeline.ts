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
  ExtractedJobCandidate,
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
  excludeSourceIds?: string[];
  keepSearchingUntilMatch?: boolean;
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

const CRAWL_BATCH_CONCURRENCY = 4;

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

async function crawlSingleSource(
  source: SourceRecord,
  params: {
    maxPagesPerSource: number;
    maxCandidatesStopThreshold: number;
    customPrompt?: string;
    startedAt: number;
    timeBudgetMs: number;
  },
): Promise<{
  report: ScannedSourceReport;
  candidates: ExtractedJobCandidate[];
  errorMessage?: string;
}> {
  const report: ScannedSourceReport = {
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

  const candidates: ExtractedJobCandidate[] = [];
  const seenLocal = new Set<string>();
  const visitedPages = new Set<string>();
  let currentPageUrl: string | null = source.url;
  let pendingPaginationMode: 'switched_pages' | 'followed_subpage' | null = null;
  let errorMessage: string | undefined;

  try {
    for (let pageIdx = 0; pageIdx < params.maxPagesPerSource; pageIdx++) {
      if (
        !currentPageUrl ||
        visitedPages.has(currentPageUrl) ||
        candidates.length >= params.maxCandidatesStopThreshold ||
        Date.now() - params.startedAt > params.timeBudgetMs
      ) {
        break;
      }

      if (pageIdx > 0 && pendingPaginationMode) {
        report.paginationStatus = pendingPaginationMode;
      }

      visitedPages.add(currentPageUrl);
      report.pagesVisited.push(currentPageUrl);

      const scraped = await scrapePageWithJina(currentPageUrl, 45000);
      report.pagesCrawled += 1;

      if (scraped.blockedReason) {
        report.status = 'blocked';
        report.paginationStatus = 'unknown';
        report.note = scraped.blockedReason;
        errorMessage = `${source.name}: ${scraped.blockedReason}`;
        break;
      }

      const extraction = await extractMatchingJobs(
        source.name,
        currentPageUrl,
        scraped.markdown,
        params.customPrompt,
      );

      for (const candidate of extraction.jobs) {
        if (seenLocal.has(candidate.url)) continue;
        seenLocal.add(candidate.url);
        candidates.push(candidate);
      }

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
      } else if (scraped.hasJsOnlyPagination && report.pagesVisited.length === 1) {
        report.paginationStatus = 'js_only';
        report.note = report.note || 'Page 1 only (JS button pagination)';
      }

      currentPageUrl = nextUrl;
    }

    if (report.pagesCrawled > 1 && !report.note) {
      report.note =
        report.paginationStatus === 'followed_subpage'
          ? `Followed careers link (${report.pagesCrawled} pages)`
          : `Switched ${report.pagesCrawled} pages`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown scan error';
    console.error(`[cron/scan] Source "${source.name}" error:`, err);
    report.status = 'error';
    report.paginationStatus = 'unknown';
    report.note = msg;
    errorMessage = `${source.name}: ${msg}`;
  }

  return { report, candidates, errorMessage };
}

export async function runDailyScan(
  options: ScanOptions | number = {},
): Promise<ScanResultSummary> {
  const opts: ScanOptions =
    typeof options === 'number' ? { maxNewJobs: options } : options;

  const maxNewJobs = clamp(opts.maxNewJobs ?? 3, 1, 5);
  const maxSources = clamp(opts.maxSources ?? 8, 1, 60);
  const maxPagesPerSource = clamp(opts.maxPagesPerSource ?? 3, 1, 3);
  const keepSearchingUntilMatch = opts.keepSearchingUntilMatch ?? true;
  const excludeSet = new Set(opts.excludeSourceIds ?? []);
  const customPrompt = opts.customPrompt?.trim() || undefined;
  const startedAt = Date.now();
  const timeBudgetMs = 95_000;

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
  ).filter((s) => !excludeSet.has(s.id));

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
    hasMoreSources: false,
    remainingSources: 0,
  };

  const reportBySourceId = new Map<string, ScannedSourceReport>();
  const toProcess: PendingCandidate[] = [];

  let cursor = 0;
  while (cursor < orderedSources.length && Date.now() - startedAt < timeBudgetMs) {
    const reachedTargetJobs = toProcess.length >= maxNewJobs;
    const reachedSourceBatchAndFoundJob =
      summary.sourcesScanned >= maxSources &&
      (!keepSearchingUntilMatch || toProcess.length > 0);

    if (reachedTargetJobs || reachedSourceBatchAndFoundJob) {
      break;
    }

    const batchSize =
      summary.sourcesScanned < maxSources
        ? Math.min(CRAWL_BATCH_CONCURRENCY, maxSources - summary.sourcesScanned)
        : CRAWL_BATCH_CONCURRENCY;
    const batch = orderedSources.slice(cursor, cursor + batchSize);
    if (batch.length === 0) break;
    cursor += batch.length;

    const batchResults = await Promise.all(
      batch.map((source) =>
        crawlSingleSource(source, {
          maxPagesPerSource,
          maxCandidatesStopThreshold: maxNewJobs,
          customPrompt,
          startedAt,
          timeBudgetMs,
        }),
      ),
    );

    const scannedIds: string[] = [];

    for (const res of batchResults) {
      const { report, candidates, errorMessage } = res;
      scannedIds.push(report.sourceId);
      summary.sourcesScanned += 1;
      summary.pagesCrawled += report.pagesCrawled;
      summary.scannedSources.push(report);
      reportBySourceId.set(report.sourceId, report);

      if (errorMessage) {
        summary.errors.push(errorMessage);
      }

      for (const candidate of candidates) {
        summary.candidatesFound += 1;
        report.candidatesFound += 1;
        report.status = 'matched';

        if (knownUrls.has(candidate.url)) {
          summary.jobsSkipped += 1;
          report.jobsSkipped += 1;
          continue;
        }

        if (toProcess.length < maxNewJobs) {
          knownUrls.add(candidate.url);
          toProcess.push({
            sourceId: report.sourceId,
            company: candidate.company,
            title: candidate.title,
            url: candidate.url,
          });
        }
      }
    }

    if (scannedIds.length > 0) {
      await supabase
        .from('sources')
        .update({ last_scanned_at: new Date().toISOString() })
        .in('id', scannedIds);
    }
  }

  const remainingSources = Math.max(0, orderedSources.length - cursor);
  summary.remainingSources = remainingSources;
  summary.hasMoreSources = remainingSources > 0;

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
