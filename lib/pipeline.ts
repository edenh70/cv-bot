import { analyzeAndTailorJob, extractMatchingJobs } from './gemini';
import { normalizeAndValidateUrl, scrapeUrlWithJina } from './jina';
import { getSupabaseAdmin } from './supabase';
import type { JobRecord, ScanResultSummary, SourceRecord } from './types';

interface PendingCandidate {
  sourceId: string;
  company: string;
  title: string;
  url: string;
}

export async function analyzeSingleJobUrl(
  rawUrl: string,
  options?: {
    sourceId?: string | null;
    companyHint?: string;
    titleHint?: string;
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

export async function runDailyScan(maxNewJobs = 3): Promise<ScanResultSummary> {
  const supabase = getSupabaseAdmin();

  const { data: sourcesData, error: sourcesError } = await supabase
    .from('sources')
    .select('*')
    .eq('is_active', true)
    .order('last_scanned_at', { ascending: true, nullsFirst: true });

  if (sourcesError) {
    throw new Error(`Failed to load sources: ${sourcesError.message}`);
  }

  const activeSources = (sourcesData ?? []) as SourceRecord[];

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
    candidatesFound: 0,
    jobsAdded: 0,
    jobsSkipped: 0,
    errors: [],
    jobs: [],
  };

  const toProcess: PendingCandidate[] = [];

  for (const source of activeSources) {
    if (toProcess.length >= maxNewJobs) {
      break;
    }

    summary.sourcesScanned += 1;

    try {
      const pageMarkdown = await scrapeUrlWithJina(source.url, 32000);
      const candidates = await extractMatchingJobs(
        source.name,
        source.url,
        pageMarkdown,
      );

      await supabase
        .from('sources')
        .update({ last_scanned_at: new Date().toISOString() })
        .eq('id', source.id);

      for (const candidate of candidates) {
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
