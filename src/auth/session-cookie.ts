import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'ierri_session';

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}
