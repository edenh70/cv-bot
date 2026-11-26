'use client';

import { useState } from 'react';
import {
  Upload,
  FileText,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { MasterCvProfilePublic, TailoredCV } from '@/lib/types';

interface MasterCvCardProps {
  hasCustomCv: boolean;
  hasOriginalDocx: boolean;
  profile: MasterCvProfilePublic | null;
  template: TailoredCV | null;
  onUpdated: (payload: {
    hasCustomCv: boolean;
    hasOriginalDocx: boolean;
    profile: MasterCvProfilePublic | null;
    template: TailoredCV;
  }) => void;
}

export function MasterCvCard({
  hasCustomCv,
  hasOriginalDocx,
  profile,
  template,
  onUpdated,
}: MasterCvCardProps) {
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showParsed, setShowParsed] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || uploading) return;

    setUploading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/master-cv', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || 'Failed to upload CV.');
        return;
      }

      setSuccessMsg(
        `Saved "${file.name}" (${data.pageCount}-page verified${data.hasOriginalDocx ? ', exact Word template preserved' : ''}).`,
      );
      onUpdated({
        hasCustomCv: true,
        hasOriginalDocx: Boolean(data.hasOriginalDocx),
        profile: data.profile,
        template: data.template,
      });
    } catch {
      setError('Network error while uploading CV.');
    } finally {
      setUploading(false);
    }
  }

  async function handleReset() {
    if (resetting || !hasCustomCv) return;
    setResetting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/master-cv', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to reset Master CV.');
        return;
      }
      setSuccessMsg('Reset to built-in default profile.');
      onUpdated({
        hasCustomCv: false,
        hasOriginalDocx: false,
        profile: null,
        template: data.template,
      });
    } catch {
      setError('Network error while resetting Master CV.');
    } finally {
      setResetting(false);
    }
  }

  const roleCount = template?.experience?.length ?? 0;
  const toolboxCount = template?.toolbox?.length ?? 0;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/90">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                hasOriginalDocx
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                  : hasCustomCv
                    ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
              }`}
            >
              {hasOriginalDocx
                ? 'Exact .docx Template Active'
                : hasCustomCv
                  ? 'Custom CV Active'
                  : 'Default Template'}
            </span>
          </div>
          <h2 className="mt-1.5 text-sm font-bold text-slate-900 dark:text-white">
            Master CV Template
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {hasCustomCv && profile
              ? `${profile.filename} · ${roleCount} roles · ${toolboxCount} skill groups`
              : 'Upload your real .docx CV. Your exact Word formatting stays untouched; only tailored text changes.'}
          </p>
          {hasCustomCv && !hasOriginalDocx && (
            <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              Re-upload your .docx file once to enable exact original Word file downloads.
            </p>
          )}
        </div>
      </div>

      {/* Upload + Preview Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#003366] px-3.5 text-xs font-semibold text-white transition hover:bg-[#004080] active:scale-[0.99] dark:bg-sky-600 dark:hover:bg-sky-500">
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Reading CV &amp; Checking 1-Page PDF...</span>
            </>
          ) : (
            <>
              <Upload className="h-4 w-4 shrink-0" />
              <span>{hasCustomCv ? 'Replace My CV' : 'Upload My CV (.pdf / .docx)'}</span>
            </>
          )}
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            disabled={uploading}
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        <a
          href="/api/master-cv/preview"
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <FileText className="h-4 w-4" />
          <span>Preview PDF</span>
        </a>

        {hasOriginalDocx && (
          <a
            href="/api/master-cv/preview?format=docx"
            className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950"
          >
            <FileText className="h-4 w-4" />
            <span>Original .docx</span>
          </a>
        )}

        {hasCustomCv && (
          <button
            type="button"
            disabled={resetting}
            onClick={handleReset}
            title="Reset to built-in default"
            aria-label="Reset to built-in default"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
          >
            {resetting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </button>
        )}
      </div>

      {successMsg && (
        <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {error && (
        <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {template && (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/50">
          <button
            type="button"
            onClick={() => setShowParsed((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            <span>Inspect Parsed CV Template ({roleCount} roles)</span>
            {showParsed ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {showParsed && (
            <div className="space-y-2 border-t border-slate-100 p-3 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
              {template.summary && (
                <div>
                  <span className="font-bold text-slate-800 dark:text-white">Summary: </span>
                  {template.summary}
                </div>
              )}
              <div>
                <div className="font-bold text-slate-800 dark:text-white">Experience:</div>
                <ul className="mt-1 space-y-1">
                  {template.experience.map((exp, i) => (
                    <li key={i}>
                      <span className="font-semibold">{exp.role}</span> — {exp.company} (
                      {exp.period}) &middot; {exp.bullets.length} bullets
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="font-bold text-slate-800 dark:text-white">Skills:</div>
                <ul className="mt-1 space-y-0.5">
                  {template.toolbox.map((tb, i) => (
                    <li key={i}>
                      <span className="font-semibold">{tb.category}:</span> {tb.items}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
