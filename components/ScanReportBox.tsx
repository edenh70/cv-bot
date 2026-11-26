'use client';

import { ExternalLink, Globe, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { ScannedSourceReport, ScanResultSummary } from '@/lib/types';

export function mergeScanSummaries(
  prev: ScanResultSummary | null,
  next: ScanResultSummary,
): ScanResultSummary {
  if (!prev) {
    return next;
  }

  const seenSourceIds = new Set(prev.scannedSources.map((s) => s.sourceId));
  const combinedSources = [
    ...prev.scannedSources,
    ...(next.scannedSources ?? []).filter((s) => !seenSourceIds.has(s.sourceId)),
  ];

  const seenJobIds = new Set(prev.jobs.map((j) => j.id));
  const combinedJobs = [
    ...prev.jobs,
    ...(next.jobs ?? []).filter((j) => !seenJobIds.has(j.id)),
  ];

  return {
    sourcesScanned: combinedSources.length,
    pagesCrawled: prev.pagesCrawled + next.pagesCrawled,
    candidatesFound: prev.candidatesFound + next.candidatesFound,
    jobsAdded: prev.jobsAdded + next.jobsAdded,
    jobsSkipped: prev.jobsSkipped + next.jobsSkipped,
    errors: Array.from(new Set([...prev.errors, ...(next.errors ?? [])])),
    jobs: combinedJobs,
    scannedSources: combinedSources,
    hasMoreSources: next.hasMoreSources,
    remainingSources: next.remainingSources,
  };
}

interface ScanReportBoxProps {
  summary: ScanResultSummary;
}

function getStatusBadge(source: ScannedSourceReport) {
  if (source.status === 'matched') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        {source.jobsAdded > 0
          ? `${source.jobsAdded} CV${source.jobsAdded === 1 ? '' : 's'} prepared`
          : `${source.candidatesFound} match${source.candidatesFound === 1 ? '' : 'es'}`}
      </span>
    );
  }
  if (source.status === 'blocked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/70 dark:text-amber-300">
        <AlertTriangle className="h-3 w-3" />
        Blocked
      </span>
    );
  }
  if (source.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-800 dark:bg-rose-950/70 dark:text-rose-300">
        <XCircle className="h-3 w-3" />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-slate-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
      0 matches
    </span>
  );
}

function getPaginationBadge(source: ScannedSourceReport) {
  if (source.paginationStatus === 'switched_pages' && source.pagesCrawled > 1) {
    return (
      <span className="rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-[#003366] dark:bg-sky-950/70 dark:text-sky-300">
        {source.pagesCrawled} pages (switched)
      </span>
    );
  }
  if (source.paginationStatus === 'followed_subpage' && source.pagesCrawled > 1) {
    return (
      <span className="rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300">
        Followed careers link ({source.pagesCrawled} pages)
      </span>
    );
  }
  if (source.paginationStatus === 'js_only') {
    return (
      <span className="rounded-md bg-amber-100/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
        1 page (JS buttons)
      </span>
    );
  }
  if (source.pagesCrawled > 0) {
    return (
      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800/80 dark:text-slate-400">
        {source.pagesCrawled} {source.pagesCrawled === 1 ? 'page' : 'pages'}
      </span>
    );
  }
  return null;
}

export function ScanReportBox({ summary }: ScanReportBoxProps) {
  const checkedSites = summary.scannedSources ?? [];

  return (
    <div className="mt-2.5 rounded-xl border border-sky-200 bg-sky-50/70 p-3 text-xs text-slate-700 dark:border-sky-800/60 dark:bg-sky-950/30 dark:text-slate-200">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="font-bold text-[#003366] dark:text-sky-300">
          Prepared {summary.jobsAdded} CV{summary.jobsAdded === 1 ? '' : 's'}
        </span>
        <span>&middot;</span>
        <span>{summary.sourcesScanned} websites checked</span>
        <span>&middot;</span>
        <span>{summary.pagesCrawled} pages crawled</span>
        <span>&middot;</span>
        <span>{summary.candidatesFound} matches</span>
      </div>

      {checkedSites.length > 0 && (
        <div className="mt-2.5 space-y-1.5 border-t border-sky-200/80 pt-2.5 dark:border-sky-800/50">
          <div className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" />
              Websites Checked ({checkedSites.length})
            </span>
            {typeof summary.remainingSources === 'number' && (
              <span className="text-[10px] font-medium normal-case tracking-normal text-slate-500 dark:text-slate-400">
                {summary.remainingSources === 0
                  ? 'All active websites checked'
                  : `${summary.remainingSources} remaining`}
              </span>
            )}
          </div>

          <ul className="space-y-1.5">
            {checkedSites.map((site) => (
              <li
                key={site.sourceId}
                className="rounded-lg border border-slate-200/80 bg-white/90 px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900/80"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <a
                    href={site.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 font-semibold text-slate-900 hover:text-[#003366] hover:underline dark:text-white dark:hover:text-sky-300"
                  >
                    <span className="truncate">{site.name}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                  </a>

                  <div className="flex flex-wrap items-center gap-1">
                    {getPaginationBadge(site)}
                    {getStatusBadge(site)}
                  </div>
                </div>

                {site.pagesVisited.length > 1 && (
                  <div className="mt-1 space-y-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                    {site.pagesVisited.map((pageUrl, idx) => (
                      <div key={pageUrl} className="truncate">
                        <span className="font-semibold text-slate-600 dark:text-slate-300">
                          P{idx + 1}:
                        </span>{' '}
                        <a
                          href={pageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {pageUrl}
                        </a>
                      </div>
                    ))}
                  </div>
                )}

                {site.note && (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    {site.note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {checkedSites.length === 0 && summary.errors.length > 0 && (
        <div className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Notes: {summary.errors.slice(0, 3).join(' | ')}
        </div>
      )}
    </div>
  );
}
