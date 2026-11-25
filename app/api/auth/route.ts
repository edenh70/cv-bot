import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createSessionCookieValue,
  getSessionCookieOptions,
  isAuthenticated,
  SESSION_COOKIE_NAME,
  verifyPassword,
} from '@/lib/auth';

const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export async function GET() {
  try {
    const authenticated = await isAuthenticated();
    return NextResponse.json({ authenticated });
  } catch (error) {
    console.error('[api/auth GET] Error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!process.env.APP_PASSWORD) {
      return NextResponse.json(
        { error: 'APP_PASSWORD is not configured on the server.' },
        { status: 500 },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Please enter your PIN or password.' },
        { status: 400 },
      );
    }

    if (!verifyPassword(parsed.data.password)) {
      return NextResponse.json(
        { error: 'Invalid password. Please try again.' },
        { status: 401 },
      );
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      SESSION_COOKIE_NAME,
      createSessionCookieValue(),
      getSessionCookieOptions(),
    );
    return response;
  } catch (error) {
    console.error('[api/auth POST] Error:', error);
    return NextResponse.json(
      { error: 'Authentication failed.' },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    ...getSessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
