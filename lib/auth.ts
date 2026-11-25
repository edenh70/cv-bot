import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = 'cv_bot_session';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeEqualStrings(a: string, b: string): boolean {
  const hashA = sha256(a);
  const hashB = sha256(b);
  return timingSafeEqual(hashA, hashB);
}

function deriveSessionToken(appPassword: string): string {
  return createHmac('sha256', appPassword)
    .update('cv-bot-session-v1')
    .digest('hex');
}

export function verifyPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected || expected.length === 0 || !input) {
    return false;
  }
  return safeEqualStrings(input, expected);
}

export function createSessionCookieValue(): string {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    throw new Error('APP_PASSWORD environment variable is not configured.');
  }
  return deriveSessionToken(password);
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
}

export async function isAuthenticated(): Promise<boolean> {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return false;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return false;
  }

  const expectedToken = deriveSessionToken(password);
  return safeEqualStrings(token, expectedToken);
}

export function isCronAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return false;
  }
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const provided = authHeader.slice('Bearer '.length).trim();
  return safeEqualStrings(provided, cronSecret);
}
