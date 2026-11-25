import { normalizeAndValidateUrl } from './jina';
import { getSupabaseAdmin } from './supabase';
import type { SourceRecord } from './types';

export const DEFAULT_GOOGLE_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1i4-O4tu2GXdPHHcxF8A5SqnwW9xQUoetffVSWYyTBTo/edit?gid=0#gid=0';

export interface SheetSourceEntry {
  name: string;
  url: string;
  is_active: boolean;
}

export interface SheetSyncResult {
  sheetUrl: string;
  totalInSheet: number;
  added: number;
  updated: number;
  deactivated: number;
  sources: SourceRecord[];
}

export function getConfiguredGoogleSheetUrl(): string {
  return (
    process.env.GOOGLE_SHEET_SOURCES_URL ||
    process.env.NEXT_PUBLIC_GOOGLE_SHEET_URL ||
    DEFAULT_GOOGLE_SHEET_URL
  ).trim();
}

export function toGoogleSheetCsvUrl(sheetUrl: string): string {
  const trimmed = sheetUrl.trim();
  if (/\/export\?.*format=csv/i.test(trimmed) || /\.csv(\?|$)/i.test(trimmed)) {
    return trimmed;
  }

  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) {
    throw new Error('Invalid Google Sheet URL.');
  }

  const gidMatch = trimmed.match(/[?#&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

export function parseCsv(text: string): string[][] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (cleaned[i + 1] === '\n') {
        i += 1;
      }
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  return rows;
}

const NAME_HEADERS = new Set([
  'name',
  'company',
  'company name',
  'source',
  'חברה',
  'שם',
]);
const URL_HEADERS = new Set([
  'url',
  'link',
  'careers',
  'career url',
  'career_url',
  'careers_url',
  'קישור',
]);
const ACTIVE_HEADERS = new Set([
  'active',
  'is_active',
  'is active',
  'enabled',
  'status',
  'פעיל',
]);

const FALSE_VALUES = new Set([
  'false',
  'no',
  '0',
  'off',
  'paused',
  'inactive',
  'disabled',
  'לא',
]);

const BOOLEAN_LIKE_VALUES = new Set([
  ...FALSE_VALUES,
  'true',
  'yes',
  '1',
  'on',
  'active',
  'enabled',
  'כן',
]);

function looksLikeUrl(cell: string): boolean {
  return /^https?:\/\//i.test(cell) || /^www\./i.test(cell);
}

function deriveCompanyNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, '');
    const base = hostname.split('.')[0] || hostname;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'Career Source';
  }
}

function parseIsActiveCell(value: string | undefined): boolean {
  if (!value) return true;
  return !FALSE_VALUES.has(value.trim().toLowerCase());
}

export function extractSourcesFromSheetRows(rows: string[][]): SheetSourceEntry[] {
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length === 0) return [];

  let nameCol = -1;
  let urlCol = -1;
  let activeCol = -1;
  let startIndex = 0;

  const firstRowLower = nonEmptyRows[0].map((c) => c.trim().toLowerCase());
  firstRowLower.forEach((cell, idx) => {
    if (nameCol === -1 && NAME_HEADERS.has(cell)) nameCol = idx;
    if (urlCol === -1 && URL_HEADERS.has(cell)) urlCol = idx;
    if (activeCol === -1 && ACTIVE_HEADERS.has(cell)) activeCol = idx;
  });

  if (urlCol !== -1 || nameCol !== -1) {
    startIndex = 1;
  }

  const seenUrls = new Set<string>();
  const results: SheetSourceEntry[] = [];

  for (let i = startIndex; i < nonEmptyRows.length; i++) {
    const row = nonEmptyRows[i];

    let rawUrl = urlCol !== -1 ? row[urlCol] ?? '' : '';
    if (!rawUrl || !looksLikeUrl(rawUrl)) {
      rawUrl = row.find((cell) => looksLikeUrl(cell)) ?? '';
    }
    if (!rawUrl) continue;

    const candidateUrl = /^www\./i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeAndValidateUrl(candidateUrl);
    } catch {
      continue;
    }

    if (seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);

    let rawName = nameCol !== -1 ? (row[nameCol] ?? '').trim() : '';
    if (!rawName) {
      rawName =
        row.find((cell) => {
          const t = cell.trim();
          return (
            t.length > 0 &&
            !looksLikeUrl(t) &&
            !BOOLEAN_LIKE_VALUES.has(t.toLowerCase())
          );
        }) ?? '';
    }

    const name = rawName || deriveCompanyNameFromUrl(normalizedUrl);

    let isActive = true;
    if (activeCol !== -1) {
      isActive = parseIsActiveCell(row[activeCol]);
    } else {
      const boolCell = row.find((cell) =>
        BOOLEAN_LIKE_VALUES.has(cell.trim().toLowerCase()),
      );
      if (boolCell !== undefined) {
        isActive = parseIsActiveCell(boolCell);
      }
    }

    results.push({
      name: name.slice(0, 100),
      url: normalizedUrl,
      is_active: isActive,
    });
  }

  return results;
}

export async function fetchSourcesFromGoogleSheet(
  sheetUrl = getConfiguredGoogleSheetUrl(),
): Promise<{ sheetUrl: string; rows: SheetSourceEntry[] }> {
  const csvUrl = toGoogleSheetCsvUrl(sheetUrl);

  const response = await fetch(csvUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });

  const contentType = response.headers.get('content-type') || '';
  if (
    response.status === 401 ||
    response.status === 403 ||
    contentType.includes('text/html')
  ) {
    throw new Error(
      'Google Sheet is private. Open the Sheet → Share → General access → change to "Anyone with the link" (Viewer), then retry.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google Sheet (${response.status} ${response.statusText}).`,
    );
  }

  const csvText = await response.text();
  const parsedRows = parseCsv(csvText);
  const rows = extractSourcesFromSheetRows(parsedRows);

  return { sheetUrl, rows };
}

export async function syncSourcesFromGoogleSheet(
  sheetUrl = getConfiguredGoogleSheetUrl(),
): Promise<SheetSyncResult> {
  const { rows } = await fetchSourcesFromGoogleSheet(sheetUrl);
  const supabase = getSupabaseAdmin();

  const { data: existingData, error: existingErr } = await supabase
    .from('sources')
    .select('id, url, name, is_active');

  if (existingErr) {
    throw new Error(`Failed to read sources: ${existingErr.message}`);
  }

  const existingByUrl = new Map<
    string,
    { id: string; url: string; name: string; is_active: boolean }
  >();
  for (const row of existingData ?? []) {
    existingByUrl.set(row.url, row);
  }

  let added = 0;
  let updated = 0;
  const sheetUrlSet = new Set<string>();

  for (const entry of rows) {
    sheetUrlSet.add(entry.url);
    const existing = existingByUrl.get(entry.url);
    if (!existing) {
      added += 1;
    } else if (
      existing.name !== entry.name ||
      existing.is_active !== entry.is_active
    ) {
      updated += 1;
    }
  }

  if (rows.length > 0) {
    const { error: upsertErr } = await supabase.from('sources').upsert(
      rows.map((entry) => ({
        name: entry.name,
        url: entry.url,
        is_active: entry.is_active,
      })),
      { onConflict: 'url' },
    );

    if (upsertErr) {
      throw new Error(`Failed to sync sources: ${upsertErr.message}`);
    }
  }

  let deactivated = 0;
  if (rows.length > 0) {
    const removedActiveIds = (existingData ?? [])
      .filter((row) => row.is_active && !sheetUrlSet.has(row.url))
      .map((row) => row.id);

    if (removedActiveIds.length > 0) {
      const { error: deactivateErr } = await supabase
        .from('sources')
        .update({ is_active: false })
        .in('id', removedActiveIds);

      if (deactivateErr) {
        throw new Error(
          `Failed to deactivate removed sources: ${deactivateErr.message}`,
        );
      }
      deactivated = removedActiveIds.length;
    }
  }

  const { data: freshSources, error: freshErr } = await supabase
    .from('sources')
    .select('*')
    .order('created_at', { ascending: false });

  if (freshErr) {
    throw new Error(`Failed to reload sources: ${freshErr.message}`);
  }

  return {
    sheetUrl,
    totalInSheet: rows.length,
    added,
    updated,
    deactivated,
    sources: (freshSources ?? []) as SourceRecord[],
  };
}
