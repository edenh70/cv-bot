'use client';

import { useState } from 'react';
import {
  FileText,
  Download,
  ExternalLink,
  RotateCcw,
  CheckCircle2,
  Calendar,
  Loader2,
} from 'lucide-react';
import type { JobRecord, JobStatus } from '@/lib/types';

interface AppliedHistoryTabProps {
  jobs: JobRecord[];
  hasOriginalDocx?: boolean;
  onStatusChange: (jobId: string, status: JobStatus) => Promise<void>;
}

function formatAppliedDate(iso: string | null, fallbackIso: string): string {
  const target = iso || fallbackIso;
  try {
    return new Intl.DateTimeFormat('en-IL', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(target));
  } catch {
    return '';
  }
}

export function AppliedHistoryTab({
  jobs,
  hasOriginalDocx = false,
  onStatusChange,
}: AppliedHistoryTabProps) {
  const [restoringId, setRestoringId] = useState<string | null>(null);

  async function handleRestore(jobId: string) {
    if (restoringId) return;
    setRestoringId(jobId);
    try {
      await onStatusChange(jobId, 'pending_review');
    } finally {
      setRestoringId(null);
    }
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-8 text-center dark:border-slate-800 dark:bg-slate-900/50">
        <CheckCircle2 className="mx-auto h-9 w-9 text-slate-400 dark:text-slate-600" />
        <h2 className="mt-3 text-sm font-bold text-slate-800 dark:text-slate-200">
          No Applied Roles Yet
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          When you click &ldquo;Mark as Applied&rdquo; on a job card, it moves here with a permanent link to the exact tailored PDF you sent.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <article
          key={job.id}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/90"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="truncate font-semibold text-[#003366] dark:text-sky-400">
                  {job.company}
                </span>
                <span>&middot;</span>
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {formatAppliedDate(job.applied_at, job.created_at)}
                </span>
              </div>
              <h3 className="mt-1 text-sm font-bold text-slate-900 dark:text-white">
                {job.title}
              </h3>
            </div>

            <span className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/50 dark:text-emerald-300">
              {job.match_score}/10
            </span>
          </div>

          <div className="mt-3 flex items-center gap-2">
            {hasOriginalDocx && (
              <a
                href={`/api/cv/${job.id}?format=docx`}
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#003366] px-3 text-xs font-semibold text-white transition hover:bg-[#004080] dark:bg-sky-600 dark:hover:bg-sky-500"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Sent .docx</span>
              </a>
            )}
            <a
              href={`/api/cv/${job.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition ${
                hasOriginalDocx
                  ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                  : 'bg-[#003366] text-white hover:bg-[#004080] dark:bg-sky-600 dark:hover:bg-sky-500'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>{hasOriginalDocx ? 'PDF' : 'View Sent PDF'}</span>
            </a>

            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Job Posting</span>
            </a>

            <button
              type="button"
              disabled={restoringId === job.id}
              onClick={() => handleRestore(job.id)}
              title="Move back to Daily Feed"
              aria-label="Move back to Daily Feed"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:text-white"
            >
              {restoringId === job.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
