'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Briefcase,
  PlusCircle,
  CheckSquare,
  Sun,
  Moon,
  LogOut,
  RefreshCw,
  Loader2,
  Inbox,
} from 'lucide-react';
import { JobCard } from './JobCard';
import { QuickAddAndSourcesTab } from './QuickAddAndSourcesTab';
import { AppliedHistoryTab } from './AppliedHistoryTab';
import { DEFAULT_GOOGLE_SHEET_URL } from '@/lib/google-sheet';
import type {
  JobRecord,
  JobStatus,
  ScanResultSummary,
  SourceRecord,
} from '@/lib/types';

type TabKey = 'feed' | 'sources' | 'applied';

interface ToastState {
  message: string;
  undoJobId?: string;
}

export function DashboardShell() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>('feed');
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sheetUrl, setSheetUrl] = useState<string>(DEFAULT_GOOGLE_SHEET_URL);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    setDarkMode(document.documentElement.classList.contains('dark'));
  }, []);

  const showToast = useCallback((message: string, undoJobId?: string) => {
    setToast({ message, undoJobId });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const loadData = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    try {
      const [jobsRes, sourcesRes] = await Promise.all([
        fetch('/api/jobs', { cache: 'no-store' }),
        fetch('/api/sources', { cache: 'no-store' }),
      ]);

      if (jobsRes.status === 401 || sourcesRes.status === 401) {
        router.refresh();
        return;
      }

      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        setJobs(jobsData.jobs ?? []);
      }
      if (sourcesRes.ok) {
        const sourcesData = await sourcesRes.json();
        setSources(sourcesData.sources ?? []);
        if (sourcesData.sheetUrl) {
          setSheetUrl(sourcesData.sheetUrl);
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function toggleTheme() {
    const nextDark = !darkMode;
    setDarkMode(nextDark);
    if (nextDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('cv-bot-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('cv-bot-theme', 'light');
    }
  }

  async function handleLogout() {
    await fetch('/api/auth', { method: 'DELETE' });
    router.refresh();
  }

  async function handleStatusChange(jobId: string, newStatus: JobStatus) {
    const previousJob = jobs.find((j) => j.id === jobId);
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (!res.ok) {
      showToast('Failed to update job status.');
      return;
    }

    const { job: updated } = (await res.json()) as { job: JobRecord };
    setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));

    if (newStatus === 'applied') {
      showToast(`Marked ${updated.company} as Applied`);
    } else if (newStatus === 'archived' && previousJob) {
      showToast(`Archived ${updated.company}`, jobId);
    } else if (newStatus === 'pending_review') {
      showToast(`Restored ${updated.company} to Daily Feed`);
    }
  }

  function handleJobAnalyzed(job: JobRecord, alreadyExisted: boolean) {
    setJobs((prev) => {
      const exists = prev.some((j) => j.id === job.id);
      if (exists) {
        return prev.map((j) => (j.id === job.id ? job : j));
      }
      return [job, ...prev];
    });
    showToast(
      alreadyExisted
        ? `${job.company} was already analyzed`
        : `Tailored CV ready for ${job.company}`,
    );
  }

  function handleScanComplete(summary: ScanResultSummary) {
    if (summary.jobs.length > 0) {
      setJobs((prev) => {
        const map = new Map(prev.map((j) => [j.id, j]));
        for (const newJob of summary.jobs) {
          map.set(newJob.id, newJob);
        }
        return Array.from(map.values()).sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
      });
    }
    showToast(
      summary.jobsAdded > 0
        ? `Added ${summary.jobsAdded} new matched role${summary.jobsAdded === 1 ? '' : 's'}`
        : 'Scan finished — no new matches found',
    );
  }

  const pendingJobs = jobs.filter((j) => j.status === 'pending_review');
  const appliedJobs = jobs
    .filter((j) => j.status === 'applied')
    .sort((a, b) => {
      const dateA = new Date(a.applied_at || a.created_at).getTime();
      const dateB = new Date(b.applied_at || b.created_at).getTime();
      return dateB - dateA;
    });

  return (
    <div className="min-h-dvh pb-24">
      {/* Sticky Top App Bar */}
      <header className="safe-pt sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-md dark:border-slate-800/80 dark:bg-[#0b1120]/90">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#003366] text-xs font-extrabold text-white shadow-sm">
              EH
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight text-slate-900 dark:text-white">
                CV Bot
              </h1>
              <p className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                Data Analyst Hunter
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadData(true)}
              disabled={refreshing}
              aria-label="Refresh jobs"
              title="Refresh"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
              />
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle dark mode"
              title="Toggle theme"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {darkMode ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Sign out"
              title="Sign out"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-300 dark:hover:bg-rose-950/50 dark:hover:text-rose-400"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-2xl px-4 pt-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500 dark:text-slate-400">
            <Loader2 className="h-7 w-7 animate-spin text-[#003366] dark:text-sky-400" />
            <p className="mt-3 text-xs font-medium">Loading your pipeline...</p>
          </div>
        ) : (
          <>
            {activeTab === 'feed' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Pending Review ({pendingJobs.length})
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveTab('sources')}
                    className="text-xs font-semibold text-[#003366] hover:underline dark:text-sky-400"
                  >
                    + Paste URL / Scan
                  </button>
                </div>

                {pendingJobs.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/80 p-8 text-center dark:border-slate-800 dark:bg-slate-900/50">
                    <Inbox className="mx-auto h-9 w-9 text-slate-400 dark:text-slate-600" />
                    <h3 className="mt-3 text-sm font-bold text-slate-800 dark:text-slate-200">
                      Feed is clear
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      New Data Analyst matches appear here every morning at 08:00 AM, or you can paste any job URL right now.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('sources')}
                      className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-xl bg-[#003366] px-4 text-xs font-semibold text-white dark:bg-sky-600"
                    >
                      <PlusCircle className="h-4 w-4" />
                      Add Job URL or Scan Sources
                    </button>
                  </div>
                ) : (
                  pendingJobs.map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      onStatusChange={handleStatusChange}
                    />
                  ))
                )}
              </div>
            )}

            {activeTab === 'sources' && (
              <QuickAddAndSourcesTab
                sources={sources}
                sheetUrl={sheetUrl}
                onJobAnalyzed={handleJobAnalyzed}
                onScanComplete={handleScanComplete}
                onSourcesChanged={() => loadData(false)}
                onSheetSynced={(syncedSources) => {
                  setSources(syncedSources);
                  showToast(`Synced ${syncedSources.length} sources from Google Sheet`);
                }}
                onJumpToFeed={() => setActiveTab('feed')}
              />
            )}

            {activeTab === 'applied' && (
              <div className="space-y-3">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Applied History ({appliedJobs.length})
                </h2>
                <AppliedHistoryTab
                  jobs={appliedJobs}
                  onStatusChange={handleStatusChange}
                />
              </div>
            )}
          </>
        )}
      </main>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed inset-x-0 bottom-20 z-40 mx-auto flex max-w-md justify-center px-4">
          <div className="flex items-center gap-3 rounded-2xl bg-slate-900 px-4 py-2.5 text-xs font-medium text-white shadow-lg dark:bg-slate-800">
            <span>{toast.message}</span>
            {toast.undoJobId && (
              <button
                type="button"
                onClick={() => {
                  const id = toast.undoJobId!;
                  setToast(null);
                  void handleStatusChange(id, 'pending_review');
                }}
                className="font-bold text-sky-400 underline"
              >
                Undo
              </button>
            )}
          </div>
        </div>
      )}

      {/* Fixed Bottom Mobile Tab Bar */}
      <nav
        aria-label="Primary navigation"
        className="safe-pb fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/90 bg-white/95 backdrop-blur-md dark:border-slate-800/90 dark:bg-[#0b1120]/95"
      >
        <div className="mx-auto grid max-w-2xl grid-cols-3 gap-1 px-2 pt-1.5">
          <button
            type="button"
            onClick={() => setActiveTab('feed')}
            className={`relative flex flex-col items-center justify-center rounded-xl py-1.5 text-[11px] font-semibold transition ${
              activeTab === 'feed'
                ? 'text-[#003366] dark:text-sky-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <div className="relative">
              <Briefcase className="h-5 w-5" />
              {pendingJobs.length > 0 && (
                <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#003366] px-1 text-[10px] font-bold text-white dark:bg-sky-500">
                  {pendingJobs.length}
                </span>
              )}
            </div>
            <span className="mt-1">Daily Feed</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('sources')}
            className={`flex flex-col items-center justify-center rounded-xl py-1.5 text-[11px] font-semibold transition ${
              activeTab === 'sources'
                ? 'text-[#003366] dark:text-sky-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <PlusCircle className="h-5 w-5" />
            <span className="mt-1">Add &amp; Sources</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('applied')}
            className={`relative flex flex-col items-center justify-center rounded-xl py-1.5 text-[11px] font-semibold transition ${
              activeTab === 'applied'
                ? 'text-[#003366] dark:text-sky-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <div className="relative">
              <CheckSquare className="h-5 w-5" />
              {appliedJobs.length > 0 && (
                <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white">
                  {appliedJobs.length}
                </span>
              )}
            </div>
            <span className="mt-1">Applied</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
