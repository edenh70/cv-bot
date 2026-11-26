'use client';

import { useState } from 'react';
import {
  FileText,
  Download,
  ExternalLink,
  CheckCircle2,
  Archive,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { JobRecord, JobStatus } from '@/lib/types';

interface JobCardProps {
  job: JobRecord;
  hasOriginalDocx?: boolean;
  onStatusChange: (jobId: string, status: JobStatus) => Promise<void>;
  onJobUpdated?: (updated: JobRecord) => void;
}

function getScoreBadgeClasses(score: number): string {
  if (score >= 8) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-300';
  }
  if (score >= 6) {
    return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/60 dark:text-amber-300';
  }
  return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-300';
}

function formatShortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IL', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function JobCard({
  job,
  hasOriginalDocx = false,
  onStatusChange,
  onJobUpdated,
}: JobCardProps) {
  const [showChanges, setShowChanges] = useState(true);
  const [busyStatus, setBusyStatus] = useState<JobStatus | null>(null);
  const [retailoring, setRetailoring] = useState(false);
  const [retailorError, setRetailorError] = useState<string | null>(null);

  async function triggerStatus(status: JobStatus) {
    if (busyStatus) return;
    setBusyStatus(status);
    try {
      await onStatusChange(job.id, status);
    } finally {
      setBusyStatus(null);
    }
  }

  async function handleRetailor() {
    if (retailoring) return;
    setRetailoring(true);
    setRetailorError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/retailor`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRetailorError(data.error || 'Failed to re-tailor CV.');
        return;
      }
      if (data.job && onJobUpdated) {
        onJobUpdated(data.job as JobRecord);
      }
    } catch {
      setRetailorError('Network error while re-tailoring CV.');
    } finally {
      setRetailoring(false);
    }
  }

  const changeLines = job.changes_made
    .split('\n')
    .map((line) => line.replace(/^[\s\-•*]+/, '').trim())
    .filter(Boolean);

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition dark:border-slate-800 dark:bg-slate-900/90">
      {/* Header: Company, Title & Match Score */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <span className="truncate font-semibold text-[#003366] dark:text-sky-400">
              {job.company}
            </span>
            <span>&middot;</span>
            <span>{formatShortDate(job.created_at)}</span>
          </div>
          <h2 className="mt-1 text-base font-bold leading-snug text-slate-900 dark:text-white">
            {job.title}
          </h2>
        </div>

        <div
          className={`shrink-0 rounded-xl border px-2.5 py-1.5 text-center ${getScoreBadgeClasses(job.match_score)}`}
          title="Match Score (1-10)"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
            Match
          </div>
          <div className="text-sm font-extrabold leading-none">
            {job.match_score}/10
          </div>
        </div>
      </div>

      {/* Hebrew Summary (RTL) */}
      <div
        dir="rtl"
        lang="he"
        className="mt-3 rounded-xl border border-slate-100 bg-slate-50/90 p-3 text-right text-sm leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-200"
      >
        {job.summary_hebrew}
      </div>

      {/* What was tailored in your CV */}
      <div className="mt-3 rounded-xl border border-sky-100 bg-sky-50/50 dark:border-sky-900/40 dark:bg-sky-950/20">
        <button
          type="button"
          onClick={() => setShowChanges((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-[#003366] dark:text-sky-300"
        >
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            What was tailored in your CV
          </span>
          {showChanges ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>

        {showChanges && (
          <ul className="space-y-1.5 border-t border-sky-100 px-3 py-2.5 text-xs leading-relaxed text-slate-700 dark:border-sky-900/40 dark:text-slate-300">
            {changeLines.map((line, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#003366] dark:bg-sky-400" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Action Buttons — Mobile Thumb-Friendly Grid */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {/* 1. Download .docx (exact original format) or Preview / Download PDF */}
        <div className="flex gap-1.5">
          {hasOriginalDocx ? (
            <>
              <a
                href={`/api/cv/${job.id}?format=docx`}
                className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#003366] px-2.5 text-xs font-semibold text-white transition hover:bg-[#004080] active:scale-[0.98] dark:bg-sky-600 dark:hover:bg-sky-500"
              >
                <Download className="h-4 w-4 shrink-0" />
                <span>Download .docx</span>
              </a>
              <a
                href={`/api/cv/${job.id}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Preview PDF"
                title="Preview PDF"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100 active:scale-[0.98] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <FileText className="h-4 w-4" />
              </a>
            </>
          ) : (
            <>
              <a
                href={`/api/cv/${job.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#003366] px-3 text-xs font-semibold text-white transition hover:bg-[#004080] active:scale-[0.98] dark:bg-sky-600 dark:hover:bg-sky-500"
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span>Preview PDF</span>
              </a>
              <a
                href={`/api/cv/${job.id}?download=1`}
                aria-label="Download PDF"
                title="Download PDF"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100 active:scale-[0.98] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <Download className="h-4 w-4" />
              </a>
            </>
          )}
        </div>

        {/* 2. Open Job Page */}
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 active:scale-[0.98] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
        >
          <ExternalLink className="h-4 w-4 shrink-0" />
          <span>Open Job Page</span>
        </a>

        {/* 3. Mark as Applied */}
        <button
          type="button"
          disabled={busyStatus !== null}
          onClick={() => triggerStatus('applied')}
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 active:scale-[0.98] disabled:opacity-60 dark:border-emerald-800/70 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950"
        >
          {busyStatus === 'applied' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          )}
          <span>Mark as Applied</span>
        </button>

        {/* 4. Archive / Dismiss + Re-tailor */}
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={retailoring || busyStatus !== null}
            onClick={handleRetailor}
            title="Re-tailor CV using current Master CV template"
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50 px-2.5 text-xs font-semibold text-[#003366] transition hover:bg-sky-100 active:scale-[0.98] disabled:opacity-60 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:bg-sky-950"
          >
            <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${retailoring ? 'animate-spin' : ''}`} />
            <span>{retailoring ? 'Updating...' : 'Re-tailor'}</span>
          </button>

          <button
            type="button"
            disabled={busyStatus !== null || retailoring}
            onClick={() => triggerStatus('archived')}
            title="Archive"
            aria-label="Archive"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 active:scale-[0.98] disabled:opacity-60 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            {busyStatus === 'archived' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Archive className="h-4 w-4 shrink-0" />
            )}
          </button>
        </div>
      </div>

      {retailorError && (
        <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
          {retailorError}
        </p>
      )}
    </article>
  );
}
