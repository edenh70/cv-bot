import { analyzeAndTailorJob, extractMatchingJobs } from './gemini';
import { syncSourcesFromGoogleSheet } from './google-sheet';
import { normalizeAndValidateUrl, scrapeUrlWithJina } from './jina';
import { getSupabaseAdmin } from './supabase';
import type { JobRecord, ScanResultSummary, SourceRecord } from './types';

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function prioritizeSourcesByPrompt(
  sources: SourceRecord[],
  customPrompt?: string,
): SourceRecord[] {
  if (!customPrompt || !customPrompt.trim()) {
    return sources;
  }

  const normalizedPrompt = customPrompt.toLowerCase();
  const tokens = normalizedPrompt
    .split(/[\s,;:|/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);

  const scoreSource = (source: SourceRecord): number => {
    const nameLower = source.name.toLowerCase();
    let hostLower = '';
    try {
      hostLower = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      hostLower = source.url.toLowerCase();
    }

    if (normalizedPrompt.includes(nameLower)) return 2;
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
  },
): Promise<{ job: JobRecord; alreadyExisted: boolean }> {
  const url = normalizeAndValidateUrl(rawUrl);
  const supabase = getSupabaseAdmin();

  const { data: existing, error: lookupError } = await supabase
    .from('jobs')
    .select('*')
    .eq('url', url)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Database lookup failed: ${lookupError.message}`);
  }

  if (existing) {
    return { job: existing as JobRecord, alreadyExisted: true };
  }

  const markdown = await scrapeUrlWithJina(url);
  const analysis = await analyzeAndTailorJob(url, markdown, {
    company: options?.companyHint,
    title: options?.titleHint,
    customPrompt: options?.customPrompt,
  });

  const { data: inserted, error: insertError } = await supabase
    .from('jobs')
    .insert({
      source_id: options?.sourceId ?? null,
      company: analysis.company,
      title: analysis.title,
      url,
      match_score: analysis.match_score,
      summary_hebrew: analysis.summary_hebrew,
      changes_made: analysis.changes_made,
      tailored_cv_json: analysis.tailored_cv_json,
      status: 'pending_review',
    })
    .select('*')
    .single();

  if (insertError) {
    // Handle race condition if another process inserted the same URL concurrently
    if (insertError.code === '23505') {
      const { data: raced } = await supabase
        .from('jobs')
        .select('*')
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
  };

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

    try {
      const visitedPages = new Set<string>();
      let currentPageUrl: string | null = source.url;

      for (let pageIdx = 0; pageIdx < maxPagesPerSource; pageIdx++) {
        if (
          !currentPageUrl ||
          visitedPages.has(currentPageUrl) ||
          toProcess.length >= maxNewJobs ||
          Date.now() - startedAt > timeBudgetMs
        ) {
          break;
        }

        visitedPages.add(currentPageUrl);
        const pageMarkdown = await scrapeUrlWithJina(currentPageUrl, 45000);
        summary.pagesCrawled += 1;

        const extraction = await extractMatchingJobs(
          source.name,
          currentPageUrl,
          pageMarkdown,
          customPrompt,
        );

        for (const candidate of extraction.jobs) {
          summary.candidatesFound += 1;
          if (knownUrls.has(candidate.url)) {
            summary.jobsSkipped += 1;
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

        currentPageUrl =
          extraction.nextPageUrl && !visitedPages.has(extraction.nextPageUrl)
            ? extraction.nextPageUrl
            : null;
      }

      await supabase
        .from('sources')
        .update({ last_scanned_at: new Date().toISOString() })
        .eq('id', source.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown scan error';
      console.error(`[cron/scan] Source "${source.name}" error:`, err);
      summary.errors.push(`${source.name}: ${msg}`);
    }
  }

  if (toProcess.length > 0) {
    const settled = await Promise.allSettled(
      toProcess.map((candidate) =>
        analyzeSingleJobUrl(candidate.url, {
          sourceId: candidate.sourceId,
          companyHint: candidate.company,
          titleHint: candidate.title,
          customPrompt,
        }),
      ),
    );

    settled.forEach((result, idx) => {
      const candidate = toProcess[idx];
      if (result.status === 'fulfilled') {
        if (result.value.alreadyExisted) {
          summary.jobsSkipped += 1;
        } else {
          summary.jobsAdded += 1;
          summary.jobs.push(result.value.job);
        }
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : 'Failed to analyze job';
        console.error(`[cron/scan] Job "${candidate.url}" error:`, result.reason);
        summary.errors.push(`${candidate.title}: ${msg}`);
      }
    });
  }

  return summary;
}
