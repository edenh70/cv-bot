const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
];

export function normalizeAndValidateUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL cannot be empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }

  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    throw new Error('Local or private network URLs are not allowed.');
  }

  parsed.hash = '';
  return parsed.toString();
}

export function resolveCandidateUrl(candidateUrl: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(candidateUrl.trim(), baseUrl);
    return normalizeAndValidateUrl(resolved.toString());
  } catch {
    return null;
  }
}

export function cleanScrapedMarkdown(raw: string, maxChars: number): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

export async function scrapeUrlWithJina(url: string, maxChars = 25000): Promise<string> {
  const normalizedUrl = normalizeAndValidateUrl(url);
  const jinaEndpoint = `https://r.jina.ai/${normalizedUrl}`;

  const headers: Record<string, string> = {
    Accept: 'text/markdown',
    'X-Return-Format': 'markdown',
  };

  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  const response = await fetch(jinaEndpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Jina Reader failed (${response.status} ${response.statusText}) for ${normalizedUrl}`);
  }

  const text = cleanScrapedMarkdown(await response.text(), maxChars);
  if (!text || text.length < 40) {
    throw new Error(`Jina Reader returned insufficient content for ${normalizedUrl}`);
  }

  return text;
}
