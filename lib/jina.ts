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

const ASSET_EXTENSION_REGEX =
  /\.(svg|png|jpe?g|gif|webp|ico|css|js|pdf|docx?|zip)(\?|$)/i;

const EXTERNAL_ATS_HOST_REGEX =
  /(greenhouse\.io|comeet\.com|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|breezy\.hr|recruitee\.com|bamboohr\.com|applytojob\.com)/i;

const CAREER_SUBPAGE_REGEX =
  /\b(careers?|jobs?|open[-_\s]?positions?|positions?|openings?|join[-_\s]?us|vacancies)\b|(קריירה|משרות|דרושים)/i;

const NEXT_LABEL_REGEX =
  /^(next(\s+page)?|הבא|לעמוד\s+הבא|עמוד\s+הבא|next\s*[›»>]|›|»|>)$/i;

const JS_PAGINATION_TEXT_REGEX =
  /(טען עוד|הצג עוד משרות|load more jobs|show more jobs|עמוד\s+1\s+מתוך|page\s+1\s+of\s+\d+)/i;

export interface ScrapedPageResult {
  markdown: string;
  fullMarkdown: string;
  blockedReason: string | null;
  nextPageUrl: string | null;
  subpageCareerUrl: string | null;
  hasJsOnlyPagination: boolean;
}

export interface ExtractedPageNavigation {
  nextPageUrl: string | null;
  subpageCareerUrl: string | null;
  hasJsOnlyPagination: boolean;
}

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

export function resolveCandidateUrl(
  candidateUrl: string,
  baseUrl: string,
): string | null {
  try {
    const resolved = new URL(candidateUrl.trim(), baseUrl);
    return normalizeAndValidateUrl(resolved.toString());
  } catch {
    return null;
  }
}

export function isKnownExternalAtsHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return EXTERNAL_ATS_HOST_REGEX.test(hostname) || /^careers\./i.test(hostname);
  } catch {
    return false;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    });
}

/**
 * Lightweight HTML-to-Markdown converter used as a fast direct fallback when
 * Jina Reader is blocked (422), rate-limited, or times out on heavy pages.
 */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const withoutScripts = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ');

  const withLinks = withoutScripts.replace(
    /<a\b([^>]*)href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi,
    (_full, _pre, dq, sq, bare, _post, inner) => {
      const rawHref = (dq ?? sq ?? bare ?? '').trim();
      const innerText = decodeHtmlEntities(
        inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      ).replace(/[\[\]]/g, '');
      if (!innerText || !rawHref) {
        return innerText ? ` ${innerText} ` : ' ';
      }
      if (rawHref.startsWith('#') || /^javascript:/i.test(rawHref)) {
        return ` [${innerText}](${rawHref}) `;
      }
      const resolved = resolveCandidateUrl(decodeHtmlEntities(rawHref), baseUrl);
      if (!resolved) {
        return ` ${innerText} `;
      }
      return ` [${innerText}](${resolved}) `;
    },
  );

  const withBreaks = withLinks
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withBreaks)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanScrapedMarkdown(raw: string, maxChars: number): string {
  const cleaned = raw
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  const headLen = Math.floor(maxChars * 0.82);
  const tailLen = Math.max(0, maxChars - headLen - 24);
  if (tailLen < 500) {
    return cleaned.slice(0, maxChars);
  }

  return `${cleaned.slice(0, headLen)}\n\n... [truncated middle] ...\n\n${cleaned.slice(-tailLen)}`;
}

function parseMarkdownLinks(
  markdown: string,
): Array<{ label: string; rawHref: string }> {
  const links: Array<{ label: string; rawHref: string }> = [];
  const regex = /(?<!!)\[([^\]]{0,140})\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    links.push({
      label: match[1].replace(/\s+/g, ' ').trim(),
      rawHref: match[2].trim(),
    });
  }
  return links;
}

export function detectBotBlock(fullMarkdown: string): string | null {
  const links = parseMarkdownLinks(fullMarkdown);
  const shortOrLocked = fullMarkdown.length < 4000 || links.length <= 3;

  if (!shortOrLocked) {
    return null;
  }

  if (
    /Cloudflare Ray ID|Attention Required!\s*\|\s*Cloudflare|Sorry, you have been blocked/i.test(
      fullMarkdown,
    )
  ) {
    return 'Blocked by Cloudflare WAF';
  }

  if (/Just a moment\.\.\.|Enable JavaScript and cookies to continue/i.test(fullMarkdown)) {
    return 'Blocked by Cloudflare browser check';
  }

  if (/Incapsula incident ID|Access Denied\s+You don't have permission/i.test(fullMarkdown)) {
    return 'Blocked by site WAF (Access Denied)';
  }

  if (/verify you are human|complete the captcha/i.test(fullMarkdown)) {
    return 'Blocked by anti-bot CAPTCHA';
  }

  return null;
}

function parsePageNumberFromUrl(url: string): number {
  try {
    const u = new URL(url);
    for (const key of ['page', 'p', 'pg', 'paged', 'pageNumber']) {
      const val = u.searchParams.get(key);
      if (val && /^\d+$/.test(val)) {
        return Math.max(1, parseInt(val, 10));
      }
    }
    const pagePathMatch = u.pathname.match(/\/page\/(\d+)\/?$/i);
    if (pagePathMatch) {
      return Math.max(1, parseInt(pagePathMatch[1], 10));
    }
    const segments = u.pathname.split('/').filter(Boolean);
    if (
      segments.length >= 2 &&
      /^\d+$/.test(segments[segments.length - 1]) &&
      /^\d+$/.test(segments[segments.length - 2]) &&
      parseInt(segments[segments.length - 1], 10) <= 50
    ) {
      return parseInt(segments[segments.length - 1], 10);
    }
  } catch {
    // ignore
  }
  return 1;
}

function isJsOnlyHref(rawHref: string): boolean {
  const lower = rawHref.toLowerCase();
  return (
    lower === '#' ||
    lower.endsWith('/#') ||
    (lower.includes('#') && lower.replace(/#.*$/, '') === '') ||
    lower.startsWith('javascript:')
  );
}

function isSameUrlIgnoringTrailingSlash(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

function hasExplicitNextPageParam(
  href: string,
  baseUrl: string,
  targetPage: number,
): boolean {
  try {
    const candidate = new URL(href);
    const current = new URL(baseUrl);
    if (candidate.hostname !== current.hostname) return false;

    for (const key of ['page', 'p', 'pg', 'paged', 'pageNumber']) {
      if (candidate.searchParams.get(key) === String(targetPage)) {
        return true;
      }
    }
    if (new RegExp(`/page/${targetPage}/?$`, 'i').test(candidate.pathname)) {
      return true;
    }

    const baseClean = current.pathname.replace(/\/+$/, '');
    const candClean = candidate.pathname.replace(/\/+$/, '');
    if (candClean === `${baseClean}/${targetPage}`) {
      return true;
    }

    const baseSegs = baseClean.split('/').filter(Boolean);
    const candSegs = candClean.split('/').filter(Boolean);
    if (
      candSegs.length === baseSegs.length &&
      candSegs.length >= 2 &&
      candSegs.slice(0, -1).join('/') === baseSegs.slice(0, -1).join('/') &&
      candSegs[candSegs.length - 1] === String(targetPage) &&
      /^\d+$/.test(baseSegs[baseSegs.length - 1])
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Deterministically inspects full cleaned markdown for URL-based next-page links,
 * JS-only `#` pagination buttons, and homepage -> careers/ATS subpages.
 */
export function extractNavigationFromMarkdown(
  fullMarkdown: string,
  currentUrl: string,
  explicitPageNumber?: number,
): ExtractedPageNavigation {
  const currentNorm = normalizeAndValidateUrl(currentUrl);
  const currentHost = new URL(currentNorm).hostname;
  const currentPath = new URL(currentNorm).pathname;
  const currentPageNum = explicitPageNumber ?? parsePageNumberFromUrl(currentNorm);
  const nextPageNum = currentPageNum + 1;

  const links = parseMarkdownLinks(fullMarkdown);
  let nextPageUrl: string | null = null;
  let subpageCareerUrl: string | null = null;
  let sawJsPaginationHref = false;

  const resolveSameHostNext = (rawHref: string): string | null => {
    if (!rawHref || isJsOnlyHref(rawHref) || ASSET_EXTENSION_REGEX.test(rawHref)) {
      return null;
    }
    const withoutHash = rawHref.split('#')[0];
    if (
      rawHref.includes('#') &&
      (!withoutHash ||
        isSameUrlIgnoringTrailingSlash(
          resolveCandidateUrl(withoutHash, currentNorm) || '',
          currentNorm,
        ))
    ) {
      return null;
    }
    const resolved = resolveCandidateUrl(rawHref, currentNorm);
    if (!resolved || isSameUrlIgnoringTrailingSlash(resolved, currentNorm)) {
      return null;
    }
    try {
      if (new URL(resolved).hostname !== currentHost) return null;
    } catch {
      return null;
    }
    return resolved;
  };

  for (const link of links) {
    if (NEXT_LABEL_REGEX.test(link.label)) {
      if (isJsOnlyHref(link.rawHref) || /#$/.test(link.rawHref)) {
        sawJsPaginationHref = true;
        continue;
      }
      const candidate = resolveSameHostNext(link.rawHref);
      if (candidate && !/\/(de|fr|ja|es)\//i.test(candidate)) {
        nextPageUrl = candidate;
        break;
      }
    }
  }

  if (!nextPageUrl) {
    for (const link of links) {
      if (link.label === String(nextPageNum)) {
        if (isJsOnlyHref(link.rawHref) || link.rawHref.endsWith('#')) {
          sawJsPaginationHref = true;
          continue;
        }
        const candidate = resolveSameHostNext(link.rawHref);
        if (
          candidate &&
          hasExplicitNextPageParam(candidate, currentNorm, nextPageNum)
        ) {
          nextPageUrl = candidate;
          break;
        }
      }
    }
  }

  if (!nextPageUrl) {
    for (const link of links) {
      const candidate = resolveSameHostNext(link.rawHref);
      if (
        candidate &&
        hasExplicitNextPageParam(candidate, currentNorm, nextPageNum)
      ) {
        nextPageUrl = candidate;
        break;
      }
    }
  }

  if (currentPageNum === 1) {
    for (const link of links) {
      if (isJsOnlyHref(link.rawHref) || ASSET_EXTENSION_REGEX.test(link.rawHref)) {
        continue;
      }
      const resolved = resolveCandidateUrl(link.rawHref, currentNorm);
      if (!resolved || isSameUrlIgnoringTrailingSlash(resolved, currentNorm)) {
        continue;
      }
      if (
        isKnownExternalAtsHost(resolved) &&
        !/introduceYourself|talent-community/i.test(resolved)
      ) {
        subpageCareerUrl = resolved;
        break;
      }
    }

    const isRootHomePage =
      currentPath === '/' || /^\/(he|en|il)\/?$/i.test(currentPath);

    if (!subpageCareerUrl && isRootHomePage) {
      for (const link of links) {
        if (isJsOnlyHref(link.rawHref) || ASSET_EXTENSION_REGEX.test(link.rawHref)) {
          continue;
        }
        const resolved = resolveCandidateUrl(link.rawHref, currentNorm);
        if (!resolved || isSameUrlIgnoringTrailingSlash(resolved, currentNorm)) {
          continue;
        }
        try {
          if (new URL(resolved).hostname !== currentHost) continue;
        } catch {
          continue;
        }
        if (CAREER_SUBPAGE_REGEX.test(`${link.label} ${resolved}`)) {
          subpageCareerUrl = resolved;
          break;
        }
      }
    }
  }

  if (!nextPageUrl && !sawJsPaginationHref) {
    const hasNumberedHashLink = links.some(
      (l) =>
        (/^[23]$/.test(l.label) || /load more|טען עוד/i.test(l.label)) &&
        (isJsOnlyHref(l.rawHref) || l.rawHref.endsWith('#')),
    );
    if (hasNumberedHashLink || JS_PAGINATION_TEXT_REGEX.test(fullMarkdown)) {
      sawJsPaginationHref = true;
    }
  }

  return {
    nextPageUrl,
    subpageCareerUrl,
    hasJsOnlyPagination: !nextPageUrl && sawJsPaginationHref,
  };
}

async function scrapeDirectHtml(normalizedUrl: string): Promise<string> {
  const response = await fetch(normalizedUrl, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `Direct fetch failed (${response.status} ${response.statusText})`,
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const finalUrl = response.url || normalizedUrl;
  const rawBody = await response.text();
  const markdown = /html|xml/i.test(contentType) || /<html|<body|<div/i.test(rawBody)
    ? htmlToMarkdown(rawBody, finalUrl)
    : cleanScrapedMarkdown(rawBody, 160_000);

  const bounded = cleanScrapedMarkdown(markdown, 160_000);
  if (!bounded || bounded.length < 40) {
    throw new Error('Direct fetch returned insufficient readable content');
  }
  return bounded;
}

async function fetchJinaMarkdown(normalizedUrl: string): Promise<string> {
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
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `Jina Reader failed (${response.status} ${response.statusText}) for ${normalizedUrl}`,
    );
  }

  const rawText = await response.text();
  const fullMarkdown = cleanScrapedMarkdown(rawText, 160_000);
  if (!fullMarkdown || fullMarkdown.length < 40) {
    throw new Error(
      `Jina Reader returned insufficient content for ${normalizedUrl}`,
    );
  }

  return fullMarkdown;
}

export async function scrapePageWithJina(
  url: string,
  maxChars = 45000,
): Promise<ScrapedPageResult> {
  const normalizedUrl = normalizeAndValidateUrl(url);

  let fullMarkdown: string | null = null;
  let jinaErrorMsg: string | null = null;
  let jinaBlockMsg: string | null = null;

  try {
    const candidate = await fetchJinaMarkdown(normalizedUrl);
    jinaBlockMsg = detectBotBlock(candidate);
    if (!jinaBlockMsg) {
      fullMarkdown = candidate;
    }
  } catch (err) {
    jinaErrorMsg = err instanceof Error ? err.message : 'Jina Reader error';
  }

  // Fallback to direct HTML fetch when Jina returns 422, times out, or hits Cloudflare
  if (!fullMarkdown) {
    try {
      const directCandidate = await scrapeDirectHtml(normalizedUrl);
      const directBlock = detectBotBlock(directCandidate);
      if (!directBlock || !jinaBlockMsg) {
        fullMarkdown = directCandidate;
      } else {
        fullMarkdown = directCandidate;
      }
    } catch (directErr) {
      if (jinaBlockMsg) {
        return {
          markdown: '',
          fullMarkdown: '',
          blockedReason: jinaBlockMsg,
          nextPageUrl: null,
          subpageCareerUrl: null,
          hasJsOnlyPagination: false,
        };
      }
      const directMsg =
        directErr instanceof Error ? directErr.message : 'Direct fetch failed';
      throw new Error(
        jinaErrorMsg
          ? `${jinaErrorMsg} (fallback: ${directMsg})`
          : `Failed to fetch ${normalizedUrl}: ${directMsg}`,
      );
    }
  }

  const blockedReason = detectBotBlock(fullMarkdown);
  const nav = blockedReason
    ? { nextPageUrl: null, subpageCareerUrl: null, hasJsOnlyPagination: false }
    : extractNavigationFromMarkdown(fullMarkdown, normalizedUrl);

  return {
    markdown: cleanScrapedMarkdown(fullMarkdown, maxChars),
    fullMarkdown,
    blockedReason,
    nextPageUrl: nav.nextPageUrl,
    subpageCareerUrl: nav.subpageCareerUrl,
    hasJsOnlyPagination: nav.hasJsOnlyPagination,
  };
}

export async function scrapeUrlWithJina(
  url: string,
  maxChars = 25000,
): Promise<string> {
  const result = await scrapePageWithJina(url, maxChars);
  return result.markdown;
}
