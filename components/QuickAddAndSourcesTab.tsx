'use client';

import { useState } from 'react';
import {
  Link2,
  Sparkles,
  Loader2,
  Plus,
  Trash2,
  Radar,
  ExternalLink,
  FileText,
  CheckCircle2,
  AlertCircle,
  Sheet,
  RefreshCw,
} from 'lucide-react';
import type { JobRecord, ScanResultSummary, SourceRecord } from '@/lib/types';

interface QuickAddAndSourcesTabProps {
  sources: SourceRecord[];
  sheetUrl: string;
  onJobAnalyzed: (job: JobRecord, alreadyExisted: boolean) => void;
  onScanComplete: (summary: ScanResultSummary) => void;
  onSourcesChanged: () => Promise<void>;
  onSheetSynced: (sources: SourceRecord[]) => void;
  onJumpToFeed: () => void;
}

function formatLastScanned(iso: string | null): string {
  if (!iso) return 'Never scanned';
  try {
    return `Scanned ${new Intl.DateTimeFormat('en-IL', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))}`;
  } catch {
    return 'Scanned recently';
  }
}

export function QuickAddAndSourcesTab({
  sources,
  sheetUrl,
  onJobAnalyzed,
  onScanComplete,
  onSourcesChanged,
  onSheetSynced,
  onJumpToFeed,
}: QuickAddAndSourcesTabProps) {
  // Single Job URL analysis state
  const [jobUrl, setJobUrl] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzedResult, setAnalyzedResult] = useState<{
    job: JobRecord;
    alreadyExisted: boolean;
  } | null>(null);

  // Add Source state
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [addingSource, setAddingSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Manual Scan state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResultSummary | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Google Sheet Sync state
  const [syncingSheet, setSyncingSheet] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Per-source action state
  const [busySourceId, setBusySourceId] = useState<string | null>(null);

  async function handleAnalyzeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobUrl.trim() || analyzing) return;

    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzedResult(null);

    try {
      const res = await fetch('/api/jobs/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: jobUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setAnalyzeError(data.error || 'Failed to analyze job URL.');
        return;
      }

      setAnalyzedResult(data);
      setJobUrl('');
      onJobAnalyzed(data.job, Boolean(data.alreadyExisted));
    } catch {
      setAnalyzeError('Network error while analyzing job URL.');
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceName.trim() || !sourceUrl.trim() || addingSource) return;

    setAddingSource(true);
    setSourceError(null);

    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sourceName.trim(),
          url: sourceUrl.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setSourceError(data.error || 'Failed to add source.');
        return;
      }

      setSourceName('');
      setSourceUrl('');
      await onSourcesChanged();
    } catch {
      setSourceError('Network error while adding source.');
    } finally {
      setAddingSource(false);
    }
  }

  async function handleToggleSource(source: SourceRecord) {
    if (busySourceId) return;
    setBusySourceId(source.id);
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !source.is_active }),
      });
      if (res.ok) {
        await onSourcesChanged();
      }
    } finally {
      setBusySourceId(null);
    }
  }

  async function handleDeleteSource(sourceId: string) {
    if (busySourceId) return;
    setBusySourceId(sourceId);
    try {
      const res = await fetch(`/api/sources/${sourceId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await onSourcesChanged();
      }
    } finally {
      setBusySourceId(null);
    }
  }

  async function handleSyncSheet() {
    if (syncingSheet) return;
    setSyncingSheet(true);
    setSyncMessage(null);
    setSyncError(null);

    try {
      const res = await fetch('/api/sources/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setSyncError(data.error || 'Failed to sync Google Sheet.');
        return;
      }

      setSyncMessage(
        `Synced ${data.totalInSheet} source${data.totalInSheet === 1 ? '' : 's'} (+${data.added} new, ${data.updated} updated, ${data.deactivated} paused).`,
      );
      onSheetSynced(data.sources ?? []);
    } catch {
      setSyncError('Network error while syncing Google Sheet.');
    } finally {
      setSyncingSheet(false);
    }
  }

  async function handleScanNow() {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    setScanResult(null);

    try {
      const res = await fetch('/api/cron/scan', { method: 'POST' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setScanError(data.error || 'Scan failed.');
        return;
      }

      setScanResult(data as ScanResultSummary);
      onScanComplete(data as ScanResultSummary);
      await onSourcesChanged();
    } catch {
      setScanError('Network error during scan.');
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Section 1: Paste Single Job URL */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#003366]/10 text-[#003366] dark:bg-sky-500/15 dark:text-sky-400">
            <Link2 className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Paste Job URL
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Scrape, score &amp; tailor a 1-page CV immediately
            </p>
          </div>
        </div>

        <form onSubmit={handleAnalyzeSubmit} className="space-y-2.5">
          <input
            type="url"
            required
            value={jobUrl}
            onChange={(e) => setJobUrl(e.target.value)}
            placeholder="https://careers.company.com/jobs/data-analyst..."
            className="h-12 w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 text-sm text-slate-900 outline-none transition focus:border-[#003366] focus:bg-white focus:ring-2 focus:ring-[#003366]/20 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:focus:border-sky-500 dark:focus:bg-slate-900"
          />

          <button
            type="submit"
            disabled={analyzing || !jobUrl.trim()}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#003366] px-4 text-sm font-semibold text-white transition hover:bg-[#004080] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500"
          >
            {analyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Scraping &amp; Tailoring CV...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Analyze &amp; Tailor CV
              </>
            )}
          </button>
        </form>

        {analyzeError && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{analyzeError}</span>
          </div>
        )}

        {analyzedResult && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-800/60 dark:bg-emerald-950/30">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  {analyzedResult.alreadyExisted
                    ? 'Already in your tracker'
                    : 'Tailored CV Ready!'}
                </span>
              </div>
              <span className="rounded-lg bg-white px-2 py-0.5 text-xs font-bold text-emerald-700 dark:bg-slate-900 dark:text-emerald-300">
                {analyzedResult.job.match_score}/10
              </span>
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-white">
              {analyzedResult.job.company} &mdash; {analyzedResult.job.title}
            </p>
            <div className="mt-2.5 flex gap-2">
              <a
                href={`/api/cv/${analyzedResult.job.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#003366] px-3 text-xs font-semibold text-white dark:bg-sky-600"
              >
                <FileText className="h-3.5 w-3.5" />
                Preview PDF
              </a>
              <button
                type="button"
                onClick={onJumpToFeed}
                className="flex h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                View in Feed
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Section 2: Career Page Sources & Scan Now */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Career Page Sources
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Scanned daily at 08:00 AM Israel time
            </p>
          </div>

          <button
            type="button"
            disabled={scanning}
            onClick={handleScanNow}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scanning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Radar className="h-3.5 w-3.5" />
                Scan Now
              </>
            )}
          </button>
        </div>

        {/* Google Sheet Sync Banner */}
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-950/60">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Sheet className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div>
                <div className="font-semibold text-slate-800 dark:text-slate-100">
                  Google Sheet Source Sync
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Auto-syncs daily before scan &middot; Columns: Company, URL
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <a
                href={sheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <ExternalLink className="h-3 w-3" />
                <span>Open Sheet</span>
              </a>

              <button
                type="button"
                disabled={syncingSheet}
                onClick={handleSyncSheet}
                className="flex h-8 items-center gap-1 rounded-lg bg-[#003366] px-2.5 text-[11px] font-semibold text-white transition hover:bg-[#004080] disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500"
              >
                <RefreshCw
                  className={`h-3 w-3 ${syncingSheet ? 'animate-spin' : ''}`}
                />
                <span>{syncingSheet ? 'Syncing...' : 'Sync Sheet'}</span>
              </button>
            </div>
          </div>

          {syncMessage && (
            <p className="mt-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {syncMessage}
            </p>
          )}

          {syncError && (
            <p className="mt-2 text-[11px] font-medium text-rose-600 dark:text-rose-400">
              {syncError}
            </p>
          )}
        </div>

        {scanError && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{scanError}</span>
          </div>
        )}

        {scanResult && (
          <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50/70 p-3 text-xs text-slate-700 dark:border-sky-800/60 dark:bg-sky-950/30 dark:text-slate-200">
            <div className="font-semibold text-[#003366] dark:text-sky-300">
              Scan Complete: {scanResult.jobsAdded} new job
              {scanResult.jobsAdded === 1 ? '' : 's'} added
            </div>
            <div className="mt-1 text-slate-600 dark:text-slate-400">
              {scanResult.sourcesScanned} sources scanned &middot;{' '}
              {scanResult.candidatesFound} Data Analyst matches &middot;{' '}
              {scanResult.jobsSkipped} already processed
            </div>
            {scanResult.errors.length > 0 && (
              <ul className="mt-1.5 list-disc pl-4 text-rose-600 dark:text-rose-400">
                {scanResult.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Add Source Form */}
        <form onSubmit={handleAddSource} className="mb-4 space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            <input
              type="text"
              required
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder="Company (e.g. Monday.com)"
              className="h-11 rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-[#003366] focus:bg-white dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:focus:border-sky-500 sm:col-span-2"
            />
            <input
              type="url"
              required
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://monday.com/careers"
              className="h-11 rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-[#003366] focus:bg-white dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:focus:border-sky-500 sm:col-span-3"
            />
          </div>

          <button
            type="submit"
            disabled={addingSource || !sourceName.trim() || !sourceUrl.trim()}
            className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-slate-100 px-4 text-xs font-semibold text-slate-800 transition hover:bg-slate-200 active:scale-[0.99] disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          >
            {addingSource ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            <span>Add Career Page Source</span>
          </button>

          {sourceError && (
            <p className="text-xs font-medium text-rose-600 dark:text-rose-400">
              {sourceError}
            </p>
          )}
        </form>

        {/* Source List */}
        {sources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            No career pages added yet. Add company career URLs above to enable daily scans.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        source.is_active ? 'bg-emerald-500' : 'bg-slate-400'
                      }`}
                    />
                    <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                      {source.name}
                    </span>
                  </div>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500 hover:underline dark:text-slate-400"
                  >
                    <span className="truncate">{source.url}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                    {formatLastScanned(source.last_scanned_at)}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busySourceId === source.id}
                    onClick={() => handleToggleSource(source)}
                    aria-label={source.is_active ? 'Pause source' : 'Activate source'}
                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                      source.is_active
                        ? 'bg-emerald-500'
                        : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        source.is_active ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  <button
                    type="button"
                    disabled={busySourceId === source.id}
                    onClick={() => handleDeleteSource(source.id)}
                    aria-label={`Delete ${source.name}`}
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/50 dark:hover:text-rose-400"
                  >
                    {busySourceId === source.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
