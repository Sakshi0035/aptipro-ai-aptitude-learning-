import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
import { GoogleGenAI, Type, GenerateContentResponse } from '@google/genai';
import { eq, desc, gt, gte, and, sql } from 'drizzle-orm';
import { db, pool, ensureSchemaInitialized } from '../src/db/index';
import {
  neonUsers,
  neonSessions,
  profiles,
  testResults,
  posts,
  geminiQuestionPool,
} from '../src/db/schema';

const envLocal = dotenv.config({ path: '.env.local' });
dotenv.config();
if (!process.env.GEMINI_API_KEY && envLocal.parsed?.GEMINI_API_KEY) {
  process.env.GEMINI_API_KEY = envLocal.parsed.GEMINI_API_KEY;
}
if (!process.env.DATABASE_URL && envLocal.parsed?.DATABASE_URL) {
  process.env.DATABASE_URL = envLocal.parsed.DATABASE_URL;
}
if (!process.env.NEON_AUTH_URL && envLocal.parsed?.NEON_AUTH_URL) {
  process.env.NEON_AUTH_URL = envLocal.parsed.NEON_AUTH_URL;
}
if (!process.env.NEON_JWKS_URL && envLocal.parsed?.NEON_JWKS_URL) {
  process.env.NEON_JWKS_URL = envLocal.parsed.NEON_JWKS_URL;
}

export const apiRouter = express.Router();

apiRouter.use(express.json({ limit: '5mb' }));
apiRouter.use(cookieParser());

apiRouter.use(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureSchemaInitialized();
    next();
  } catch (error: any) {
    console.error('Database initialization error:', error);
    res.status(500).json({ error: 'Database connection failed. Please verify DATABASE_URL.' });
  }
});

const SESSION_COOKIE_NAME = 'neon_auth_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getNeonAuthUrl(): string {
  if (process.env.NEON_AUTH_URL) {
    return process.env.NEON_AUTH_URL.replace(/\/+$/, '');
  }
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      const dbName = parsed.pathname.replace(/^\/+/, '').split('/')[0] || 'neondb';
      const hostParts = parsed.hostname.split('.');
      if (hostParts.length >= 2) {
        const endpointId = hostParts[0].replace(/-pooler$/, '');
        const restHost = hostParts.slice(1).join('.');
        return `https://${endpointId}.neonauth.${restHost}/${dbName}/auth`;
      }
    } catch {
      // ignore URL parse error
    }
  }
  throw new Error('NEON_AUTH_URL or DATABASE_URL environment variable is not configured.');
}

function getNeonJwksUrl(): string {
  if (process.env.NEON_JWKS_URL) {
    return process.env.NEON_JWKS_URL;
  }
  return `${getNeonAuthUrl()}/.well-known/jwks.json`;
}

function getAppOrigin(req: Request): string {
  if (req.headers.origin) {
    return String(req.headers.origin);
  }
  const rawProto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const proto = String(rawProto).split(',')[0].trim();
  const rawHost = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  const host = String(rawHost).split(',')[0].trim();
  return `${proto}://${host}`;
}

// Automatically ensure current app origin is in neon_auth.project_config.trusted_origins
const trustedOriginsCache = new Set<string>();
async function ensureTrustedOrigin(origin: string): Promise<void> {
  if (!origin || trustedOriginsCache.has(origin)) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE neon_auth.project_config
         SET trusted_origins = CASE
           WHEN NOT (COALESCE(trusted_origins, '[]'::jsonb) @> to_jsonb($1::text))
           THEN COALESCE(trusted_origins, '[]'::jsonb) || to_jsonb($1::text)
           ELSE trusted_origins
         END`,
        [origin]
      );
      trustedOriginsCache.add(origin);
    } finally {
      client.release();
    }
  } catch {
    // Ignore if role does not have update privilege on neon_auth.project_config
  }
}

function setSessionCookie(req: Request, res: Response, token: string) {
  const isSecure =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').includes('https') ||
    process.env.NODE_ENV === 'production';

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'none' : 'lax',
    partitioned: isSecure,
    path: '/',
    maxAge: SESSION_DURATION_MS,
  } as any);
}

function clearSessionCookie(req: Request, res: Response) {
  const isSecure =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').includes('https') ||
    process.env.NODE_ENV === 'production';

  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'none' : 'lax',
    partitioned: isSecure,
    path: '/',
  } as any);
}

// JWKS cache for verifying Neon Auth EdDSA JWTs
let cachedJwksKeys: any[] | null = null;
let cachedJwksExpiry = 0;

async function verifyNeonAuthJwt(jwtToken: string): Promise<{ sub: string; email: string } | null> {
  try {
    const parts = jwtToken.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    if (payload.exp && Date.now() >= payload.exp * 1000) {
      return null;
    }

    if (!cachedJwksKeys || Date.now() > cachedJwksExpiry) {
      const jwksRes = await fetch(getNeonJwksUrl());
      if (jwksRes.ok) {
        const jwksData = (await jwksRes.json()) as { keys?: any[] };
        cachedJwksKeys = jwksData.keys || [];
        cachedJwksExpiry = Date.now() + 10 * 60 * 1000;
      }
    }

    const jwk = cachedJwksKeys?.find((k) => !header.kid || k.kid === header.kid) || cachedJwksKeys?.[0];
    if (!jwk) return null;

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');

    const isValid = crypto.verify(null, signingInput, publicKey, signature);
    if (!isValid) return null;

    return {
      sub: payload.sub || payload.id,
      email: payload.email,
    };
  } catch {
    return null;
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  email_verified: boolean;
  created_at: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  neonSessionToken?: string;
}

async function ensureUserProfile(
  userId: string,
  email: string,
  defaultName?: string | null,
  defaultImage?: string | null
) {
  const existing = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (existing.length > 0) {
    return {
      id: existing[0].id,
      username: existing[0].username,
      avatar_url: existing[0].avatarUrl,
      score: existing[0].score,
    };
  }

  const username = defaultName?.trim() || email.split('@')[0];
  const inserted = await db
    .insert(profiles)
    .values({
      id: userId,
      username,
      avatarUrl: defaultImage || null,
      score: 0,
    })
    .onConflictDoUpdate({
      target: profiles.id,
      set: { updatedAt: new Date() },
    })
    .returning();

  return {
    id: inserted[0].id,
    username: inserted[0].username,
    avatar_url: inserted[0].avatarUrl,
    score: inserted[0].score,
  };
}

async function resolveSessionUser(req: AuthenticatedRequest): Promise<{
  user: AuthenticatedUser;
  profile: { id: string; username: string | null; avatar_url: string | null; score: number };
  sessionToken: string;
} | null> {
  let rawToken: string | undefined =
    req.cookies?.[SESSION_COOKIE_NAME] ||
    req.cookies?.['__Secure-neon-auth.session_token'] ||
    req.cookies?.['neon-auth.session_token'];

  if (!rawToken && req.headers.authorization?.startsWith('Bearer ')) {
    rawToken = req.headers.authorization.slice(7).trim();
  }

  if (!rawToken) return null;

  // 1. Check if token is a 3-part Neon Auth EdDSA JWT (verified against NEON_JWKS_URL)
  if (rawToken.split('.').length === 3) {
    const verifiedJwt = await verifyNeonAuthJwt(rawToken);
    if (verifiedJwt?.sub) {
      const userRows = await db
        .select()
        .from(neonUsers)
        .where(eq(neonUsers.id, verifiedJwt.sub))
        .limit(1);

      if (userRows.length > 0) {
        const u = userRows[0];
        const profile = await ensureUserProfile(u.id, u.email, u.name, u.image);
        return {
          user: {
            id: u.id,
            email: u.email,
            email_verified: u.emailVerified,
            created_at: u.createdAt.toISOString(),
          },
          profile,
          sessionToken: rawToken,
        };
      }
    }
  }

  // 2. Verify Neon Auth session token directly against neon_auth.session & neon_auth.user
  // Note: Better Auth / Neon Auth cookie format is `<token>.<hmac_signature>`, where `<token>` is stored in neon_auth.session.token
  const sessionTokenPart = decodeURIComponent(rawToken).split('.')[0];

  const sessionRows = await db
    .select({
      session: neonSessions,
      user: neonUsers,
    })
    .from(neonSessions)
    .innerJoin(neonUsers, eq(neonSessions.userId, neonUsers.id))
    .where(
      and(
        eq(neonSessions.token, sessionTokenPart),
        gt(neonSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (sessionRows.length === 0) {
    return null;
  }

  const { user: u, session: s } = sessionRows[0];
  const profile = await ensureUserProfile(u.id, u.email, u.name, u.image);

  return {
    user: {
      id: u.id,
      email: u.email,
      email_verified: u.emailVerified,
      created_at: u.createdAt.toISOString(),
    },
    profile,
    sessionToken: s.token,
  };
}

async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const resolved = await resolveSessionUser(req);
    if (!resolved) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    req.user = resolved.user;
    req.neonSessionToken = resolved.sessionToken;
    next();
  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({ error: 'Internal authentication error.' });
  }
}

// ==========================================
// NEON AUTHENTICATION ROUTES
// ==========================================

apiRouter.get('/auth/config', (_req: Request, res: Response) => {
  try {
    return res.json({
      neonAuthUrl: getNeonAuthUrl(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

apiRouter.get('/auth/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resolved = await resolveSessionUser(req);
    if (!resolved) {
      return res.json({ user: null, profile: null });
    }
    return res.json({
      user: resolved.user,
      profile: resolved.profile,
      sessionToken: resolved.sessionToken,
    });
  } catch (error: any) {
    console.error('Error in GET /api/auth/me:', error);
    return res.status(500).json({ error: 'Failed to verify Neon Auth session.' });
  }
});

async function extractOrResolveNeonSessionToken(
  neonRes: globalThis.Response,
  data: any,
  userId: string
): Promise<string> {
  if (data?.token && typeof data.token === 'string') {
    return data.token;
  }
  if (data?.session?.token && typeof data.session.token === 'string') {
    return data.session.token;
  }
  const setCookie = neonRes.headers.get('set-cookie') || '';
  const match = setCookie.match(/session_token=([^;.]+)/);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }
  const latestSession = await db
    .select()
    .from(neonSessions)
    .where(and(eq(neonSessions.userId, userId), gt(neonSessions.expiresAt, new Date())))
    .orderBy(desc(neonSessions.createdAt))
    .limit(1);
  if (latestSession.length > 0) {
    return latestSession[0].token;
  }
  return '';
}

apiRouter.post('/auth/signup', async (req: Request, res: Response) => {
  try {
    const { email, password, username } = req.body || {};
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const origin = getAppOrigin(req);
    await ensureTrustedOrigin(origin);

    const normalizedEmail = email.trim().toLowerCase();
    const displayName =
      typeof username === 'string' && username.trim()
        ? username.trim()
        : normalizedEmail.split('@')[0];

    let neonRes = await fetch(`${getNeonAuthUrl()}/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        email: normalizedEmail,
        password,
        name: displayName,
      }),
    });

    let data = (await neonRes.json().catch(() => ({}))) as any;

    // If user already exists in Neon Auth, attempt sign-in with the provided password
    if (
      !neonRes.ok &&
      (neonRes.status === 422 ||
        String(data?.code || '').includes('USER_ALREADY_EXISTS') ||
        String(data?.message || '').toLowerCase().includes('already exists'))
    ) {
      const signInRes = await fetch(`${getNeonAuthUrl()}/sign-in/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
        }),
      });
      const signInData = (await signInRes.json().catch(() => ({}))) as any;
      if (signInRes.ok && signInData?.user) {
        neonRes = signInRes;
        data = signInData;
      } else {
        return res.status(409).json({
          error:
            'An account with this email already exists. Please switch to Sign In or use Forgot Password.',
        });
      }
    }

    if (!neonRes.ok || !data?.user) {
      return res.status(neonRes.status || 400).json({
        error: data?.message || data?.error || 'Failed to sign up with Neon Auth.',
      });
    }

    const neonUser = data.user;
    const sessionToken = await extractOrResolveNeonSessionToken(neonRes, data, neonUser.id);

    if (sessionToken) {
      setSessionCookie(req, res, sessionToken);
    }
    const profile = await ensureUserProfile(
      neonUser.id,
      neonUser.email,
      neonUser.name,
      neonUser.image
    );

    return res.status(201).json({
      user: {
        id: neonUser.id,
        email: neonUser.email,
        email_verified: Boolean(neonUser.emailVerified),
        created_at: neonUser.createdAt,
      },
      profile,
      sessionToken,
    });
  } catch (error: any) {
    console.error('Error in POST /api/auth/signup:', error);
    return res.status(500).json({ error: 'Failed to create account with Neon Auth.' });
  }
});

apiRouter.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const origin = getAppOrigin(req);
    await ensureTrustedOrigin(origin);

    const neonRes = await fetch(`${getNeonAuthUrl()}/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        password,
      }),
    });

    const data = (await neonRes.json().catch(() => ({}))) as any;
    if (!neonRes.ok || !data?.user) {
      return res.status(neonRes.status || 401).json({
        error: data?.message || data?.error || 'Invalid login credentials.',
      });
    }

    const neonUser = data.user;
    const sessionToken = await extractOrResolveNeonSessionToken(neonRes, data, neonUser.id);

    if (sessionToken) {
      setSessionCookie(req, res, sessionToken);
    }
    const profile = await ensureUserProfile(
      neonUser.id,
      neonUser.email,
      neonUser.name,
      neonUser.image
    );

    return res.json({
      user: {
        id: neonUser.id,
        email: neonUser.email,
        email_verified: Boolean(neonUser.emailVerified),
        created_at: neonUser.createdAt,
      },
      profile,
      sessionToken,
    });
  } catch (error: any) {
    console.error('Error in POST /api/auth/login:', error);
    return res.status(500).json({ error: 'Failed to sign in with Neon Auth.' });
  }
});

apiRouter.post('/auth/logout', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resolved = await resolveSessionUser(req);
    if (resolved?.sessionToken) {
      await db
        .delete(neonSessions)
        .where(eq(neonSessions.token, resolved.sessionToken))
        .catch(() => {});
    }
    clearSessionCookie(req, res);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error in POST /api/auth/logout:', error);
    clearSessionCookie(req, res);
    return res.json({ success: true });
  }
});

apiRouter.post('/auth/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const origin = getAppOrigin(req);
    await ensureTrustedOrigin(origin);

    const normalizedEmail = email.trim().toLowerCase();

    const resetRoute = new URL('/#/reset-password', origin).toString();

    const neonRes = await fetch(`${getNeonAuthUrl()}/request-password-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        email: normalizedEmail,
        redirectTo: resetRoute,
      }),
    });

    const data = (await neonRes.json().catch(() => ({}))) as any;
    if (!neonRes.ok) {
      return res.status(neonRes.status).json({
        error: data?.message || data?.error || 'Failed to request password reset.',
      });
    }

    // Also retrieve the Neon Auth verification token for this user so password reset works immediately in-app
    let resetToken: string | undefined;
    try {
      const userRows = await db
        .select()
        .from(neonUsers)
        .where(eq(neonUsers.email, normalizedEmail))
        .limit(1);

      if (userRows.length > 0) {
        const client = await pool.connect();
        try {
          const verRes = await client.query(
            `SELECT identifier FROM neon_auth.verification
             WHERE value = $1 AND identifier LIKE 'reset-password:%' AND "expiresAt" > now()
             ORDER BY "createdAt" DESC LIMIT 1`,
            [userRows[0].id]
          );
          if (verRes.rows.length > 0) {
            resetToken = String(verRes.rows[0].identifier).replace('reset-password:', '');
          }
        } finally {
          client.release();
        }
      }
    } catch {
      // Ignore if verification lookup fails; email was still sent by Neon Auth
    }

    return res.json({
      message: data?.message || 'Check your email for password reset instructions.',
      resetToken,
    });
  } catch (error: any) {
    console.error('Error in POST /api/auth/forgot-password:', error);
    return res.status(500).json({ error: 'Failed to request password reset.' });
  }
});

apiRouter.post('/auth/reset-password', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token, password } = req.body || {};
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password should be at least 6 characters.' });
    }
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        error: 'Password reset token is required. Please use the link from your reset email.',
      });
    }

    const origin = getAppOrigin(req);
    await ensureTrustedOrigin(origin);

    const neonRes = await fetch(`${getNeonAuthUrl()}/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({
        newPassword: password,
        token: token.trim(),
      }),
    });

    const data = (await neonRes.json().catch(() => ({}))) as any;
    if (!neonRes.ok) {
      return res.status(neonRes.status).json({
        error: data?.message || data?.error || 'Invalid or expired password reset token.',
      });
    }

    return res.json({
      message: 'Your password has been updated successfully! Please sign in with your new password.',
    });
  } catch (error: any) {
    console.error('Error in POST /api/auth/reset-password:', error);
    return res.status(500).json({ error: 'Failed to update password.' });
  }
});

// Neon Auth Google OAuth Initiation & Popup/Redirect Handlers
apiRouter.post('/auth/google', async (req: Request, res: Response) => {
  try {
    const { callbackOrigin } = req.body || {};
    const origin = callbackOrigin || getAppOrigin(req);
    await ensureTrustedOrigin(origin);

    return res.json({
      neonAuthUrl: getNeonAuthUrl(),
      popupStartUrl: `${origin}/api/auth/google/popup-start`,
      callbackURL: `${origin}/api/auth/google/popup-callback`,
    });
  } catch (error: any) {
    console.error('Error in POST /api/auth/google:', error);
    return res.status(500).json({ error: 'Failed to prepare Neon Auth Google Sign-In.' });
  }
});

apiRouter.get('/auth/google/popup-start', async (req: Request, res: Response) => {
  const origin = getAppOrigin(req);
  await ensureTrustedOrigin(origin);
  const neonAuthUrl = getNeonAuthUrl();

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connecting to Google...</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #111827; color: #f9fafb; }
    .box { text-align: center; padding: 24px; max-width: 360px; }
    .spinner { width: 40px; height: 40px; border: 4px solid rgba(249,115,22,0.2); border-top-color: #f97316; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <p id="status">Redirecting to Google Sign-In...</p>
  </div>
  <script>
    (async function() {
      try {
        const callbackURL = window.location.origin + '/api/auth/google/popup-callback';
        const res = await fetch(${JSON.stringify(`${neonAuthUrl}/sign-in/social`)}, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: callbackURL,
            newUserCallbackURL: callbackURL,
            errorCallbackURL: callbackURL
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.url) {
          window.location.replace(data.url);
        } else {
          const errMsg = (data && (data.message || data.error)) || 'Failed to start Google Sign-In.';
          document.getElementById('status').textContent = errMsg;
          if (window.opener) {
            window.opener.postMessage({ type: 'NEON_OAUTH_ERROR', error: errMsg }, '*');
          }
        }
      } catch (err) {
        document.getElementById('status').textContent = 'Network error starting Google Sign-In.';
        if (window.opener) {
          window.opener.postMessage({ type: 'NEON_OAUTH_ERROR', error: 'Network error starting Google Sign-In.' }, '*');
        }
      }
    })();
  </script>
</body>
</html>`);
});

apiRouter.get('/auth/google/popup-callback', async (_req: Request, res: Response) => {
  const neonAuthUrl = getNeonAuthUrl();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Completing Sign-In...</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #111827; color: #f9fafb; }
    .box { text-align: center; padding: 24px; max-width: 360px; }
    .spinner { width: 40px; height: 40px; border: 4px solid rgba(249,115,22,0.2); border-top-color: #f97316; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <p id="status">Completing authentication...</p>
  </div>
  <script>
    (async function() {
      try {
        const params = new URLSearchParams(window.location.search);
        const oauthError = params.get('error_description') || params.get('error');
        if (oauthError) {
          if (window.opener) {
            window.opener.postMessage({ type: 'NEON_OAUTH_ERROR', error: oauthError }, '*');
            window.close();
            return;
          }
          window.location.replace('/#/auth?error_description=' + encodeURIComponent(oauthError));
          return;
        }

        const verifier = params.get('neon_auth_session_verifier');
        let sessionToken = null;

        try {
          const gsUrl = verifier
            ? ${JSON.stringify(`${neonAuthUrl}/get-session`)} + '?neon_auth_session_verifier=' + encodeURIComponent(verifier)
            : ${JSON.stringify(`${neonAuthUrl}/get-session`)};
          const gsRes = await fetch(gsUrl, { credentials: 'include' });
          const gsData = await gsRes.json().catch(() => null);
          sessionToken = (gsData && gsData.session && gsData.session.token) || (gsData && gsData.token) || null;
        } catch (e) {
          // Will fallback to verifier resolution in /api/auth/neon-sync
        }

        const syncRes = await fetch('/api/auth/neon-sync', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken, verifier })
        });
        const syncData = await syncRes.json().catch(() => null);

        if (syncRes.ok && syncData && syncData.sessionToken) {
          try {
            sessionStorage.setItem('aptipro_neon_session_token', syncData.sessionToken);
          } catch (e) {}

          if (window.opener) {
            window.opener.postMessage({
              type: 'NEON_OAUTH_SUCCESS',
              sessionToken: syncData.sessionToken,
              user: syncData.user,
              profile: syncData.profile
            }, '*');
            window.close();
            return;
          }
          window.location.replace('/#/dashboard');
        } else {
          const errMsg = (syncData && syncData.error) || 'Could not retrieve Google session.';
          if (window.opener) {
            window.opener.postMessage({ type: 'NEON_OAUTH_ERROR', error: errMsg }, '*');
            window.close();
            return;
          }
          window.location.replace('/#/auth?error_description=' + encodeURIComponent(errMsg));
        }
      } catch (err) {
        if (window.opener) {
          window.opener.postMessage({ type: 'NEON_OAUTH_ERROR', error: 'Google Sign-In failed.' }, '*');
          window.close();
          return;
        }
        window.location.replace('/#/auth?error_description=Google+Sign-In+failed');
      }
    })();
  </script>
</body>
</html>`);
});

// Sync a browser-established Neon Auth session (e.g., after Google OAuth redirect) with the app server
apiRouter.post('/auth/neon-sync', async (req: Request, res: Response) => {
  try {
    const { sessionToken, verifier } = req.body || {};

    let resolvedSessionRow: {
      session: typeof neonSessions.$inferSelect;
      user: typeof neonUsers.$inferSelect;
    } | null = null;

    if (sessionToken && typeof sessionToken === 'string') {
      const tokenPart = decodeURIComponent(sessionToken).split('.')[0];
      const sessionRows = await db
        .select({
          session: neonSessions,
          user: neonUsers,
        })
        .from(neonSessions)
        .innerJoin(neonUsers, eq(neonSessions.userId, neonUsers.id))
        .where(
          and(
            eq(neonSessions.token, tokenPart),
            gt(neonSessions.expiresAt, new Date())
          )
        )
        .limit(1);

      if (sessionRows.length > 0) {
        resolvedSessionRow = sessionRows[0];
      }
    }

    // Fallback when browser blocked third-party challenge cookies during get-session:
    // verify the Neon Auth OAuth session verifier directly in neon_auth.verification & neon_auth.session
    if (!resolvedSessionRow && verifier && typeof verifier === 'string') {
      const client = await pool.connect();
      try {
        const verRes = await client.query(
          `SELECT value, "updatedAt" FROM neon_auth.verification
           WHERE identifier = $1 AND "expiresAt" > now()
           ORDER BY "createdAt" DESC LIMIT 1`,
          [verifier.trim()]
        );

        let candidateToken: string | null = null;
        if (verRes.rows.length > 0 && verRes.rows[0].value) {
          const rawVal = String(verRes.rows[0].value).trim();
          try {
            const parsedVal = JSON.parse(rawVal);
            candidateToken =
              parsedVal?.session?.token ||
              parsedVal?.token ||
              parsedVal?.sessionToken ||
              null;
          } catch {
            candidateToken = rawVal.split('.')[0];
          }
        }

        if (candidateToken) {
          const rows = await db
            .select({
              session: neonSessions,
              user: neonUsers,
            })
            .from(neonSessions)
            .innerJoin(neonUsers, eq(neonSessions.userId, neonUsers.id))
            .where(
              and(
                eq(neonSessions.token, candidateToken.split('.')[0]),
                gt(neonSessions.expiresAt, new Date())
              )
            )
            .limit(1);
          if (rows.length > 0) {
            resolvedSessionRow = rows[0];
          }
        }

        if (!resolvedSessionRow) {
          // Check for the session just created during this OAuth callback window
          const recentCutoff = new Date(Date.now() - 2 * 60 * 1000);
          const recentRows = await db
            .select({
              session: neonSessions,
              user: neonUsers,
            })
            .from(neonSessions)
            .innerJoin(neonUsers, eq(neonSessions.userId, neonUsers.id))
            .where(
              and(
                gte(neonSessions.createdAt, recentCutoff),
                gt(neonSessions.expiresAt, new Date())
              )
            )
            .orderBy(desc(neonSessions.createdAt))
            .limit(1);

          if (recentRows.length > 0) {
            resolvedSessionRow = recentRows[0];
          }
        }
      } finally {
        client.release();
      }
    }

    if (!resolvedSessionRow) {
      return res.status(401).json({ error: 'Invalid or expired Neon Auth session.' });
    }

    const { user: u, session: s } = resolvedSessionRow;
    setSessionCookie(req, res, s.token);
    const profile = await ensureUserProfile(u.id, u.email, u.name, u.image);

    return res.json({
      user: {
        id: u.id,
        email: u.email,
        email_verified: u.emailVerified,
        created_at: u.createdAt.toISOString(),
      },
      profile,
      sessionToken: s.token,
    });
  } catch (error: any) {
    console.error('Error in POST /api/auth/neon-sync:', error);
    return res.status(500).json({ error: 'Failed to sync Neon Auth session.' });
  }
});

apiRouter.delete('/auth/account', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await db.delete(neonUsers).where(eq(neonUsers.id, userId));
    clearSessionCookie(req, res);
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting user account:', error);
    return res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// ==========================================
// PROFILE & STORAGE ROUTES (Neon PostgreSQL)
// ==========================================

apiRouter.get('/profiles/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profileId = String(req.params.id);
    const profileRows = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);

    if (profileRows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const p = profileRows[0];
    const formattedProfile = {
      id: p.id,
      username: p.username,
      avatar_url: p.avatarUrl,
      score: p.score,
    };

    const userPosts = await db
      .select()
      .from(posts)
      .where(eq(posts.userId, profileId))
      .orderBy(desc(posts.createdAt))
      .limit(5);

    const formattedPosts = userPosts.map((post) => ({
      id: post.id,
      created_at: post.createdAt.toISOString(),
      content: post.content,
      user_id: post.userId,
      profiles: formattedProfile,
    }));

    return res.json({
      profile: formattedProfile,
      recentPosts: formattedPosts,
    });
  } catch (error: any) {
    console.error('Error fetching profile:', error);
    return res.status(500).json({ error: 'Failed to load profile data.' });
  }
});

apiRouter.patch('/profiles/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { username, avatar_url } = req.body || {};

    const updateValues: Partial<typeof profiles.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (typeof username === 'string') {
      const trimmed = username.trim();
      if (!trimmed || trimmed.length > 50) {
        return res.status(400).json({ error: 'Username must be between 1 and 50 characters.' });
      }
      updateValues.username = trimmed;
      await db
        .update(neonUsers)
        .set({ name: trimmed, updatedAt: new Date() })
        .where(eq(neonUsers.id, userId))
        .catch(() => {});
    }

    if (typeof avatar_url === 'string' || avatar_url === null) {
      updateValues.avatarUrl = avatar_url;
    }

    const updated = await db
      .update(profiles)
      .set(updateValues)
      .where(eq(profiles.id, userId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const p = updated[0];
    return res.json({
      profile: {
        id: p.id,
        username: p.username,
        avatar_url: p.avatarUrl,
        score: p.score,
      },
    });
  } catch (error: any) {
    console.error('Error updating profile:', error);
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

apiRouter.post('/storage/avatar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { avatarDataUrl } = req.body || {};

    if (
      !avatarDataUrl ||
      typeof avatarDataUrl !== 'string' ||
      !avatarDataUrl.startsWith('data:image/')
    ) {
      return res.status(400).json({ error: 'Invalid image payload.' });
    }

    if (avatarDataUrl.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Avatar image must be smaller than 2MB.' });
    }

    const updated = await db
      .update(profiles)
      .set({
        avatarUrl: avatarDataUrl,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, userId))
      .returning();

    await db
      .update(neonUsers)
      .set({ image: avatarDataUrl, updatedAt: new Date() })
      .where(eq(neonUsers.id, userId))
      .catch(() => {});

    const p = updated[0];
    return res.json({
      publicUrl: p.avatarUrl,
      profile: {
        id: p.id,
        username: p.username,
        avatar_url: p.avatarUrl,
        score: p.score,
      },
    });
  } catch (error: any) {
    console.error('Error uploading avatar:', error);
    return res.status(500).json({ error: 'Failed to upload avatar.' });
  }
});

// ==========================================
// LEADERBOARD ROUTES (Neon PostgreSQL)
// ==========================================

apiRouter.get('/leaderboard', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const topProfiles = await db
      .select()
      .from(profiles)
      .orderBy(desc(profiles.score))
      .limit(10);

    const leaderboard = topProfiles.map((p, idx) => ({
      id: p.id,
      username: p.username,
      avatar_url: p.avatarUrl,
      score: p.score,
      rank: idx + 1,
    }));

    const currentUserProfile = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, req.user!.id))
      .limit(1);

    let userRank = 1;
    if (currentUserProfile.length > 0) {
      const userScore = currentUserProfile[0].score;
      const higherCountResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(profiles)
        .where(gt(profiles.score, userScore));
      userRank = (higherCountResult[0]?.count ?? 0) + 1;
    }

    return res.json({ leaderboard, userRank });
  } catch (error: any) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// ==========================================
// TEST RESULTS & XP ROUTES (Neon PostgreSQL)
// ==========================================

apiRouter.get('/test-results', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const rows = await db
      .select()
      .from(testResults)
      .where(
        and(
          eq(testResults.userId, req.user!.id),
          gte(testResults.createdAt, sevenDaysAgo)
        )
      )
      .orderBy(desc(testResults.createdAt));

    const results = rows.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      topic: r.topic,
      score: r.score,
      total_questions: r.totalQuestions,
      user_id: r.userId,
    }));

    return res.json({ results });
  } catch (error: any) {
    console.error('Error fetching test results:', error);
    return res.status(500).json({ error: 'Failed to fetch test results.' });
  }
});

apiRouter.post('/test-results', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { topic, score, total_questions } = req.body || {};

    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'Topic is required.' });
    }
    const numericScore = Number(score);
    const numericTotal = Number(total_questions);

    if (
      !Number.isInteger(numericScore) ||
      numericScore < 0 ||
      !Number.isInteger(numericTotal) ||
      numericTotal <= 0
    ) {
      return res.status(400).json({ error: 'Invalid score or total_questions.' });
    }

    const insertedResult = await db
      .insert(testResults)
      .values({
        userId,
        topic: topic.trim(),
        score: numericScore,
        totalQuestions: numericTotal,
      })
      .returning();

    const pointsEarned = numericScore * 100;
    let updatedProfileRow;

    if (pointsEarned > 0) {
      const updated = await db
        .update(profiles)
        .set({
          score: sql`${profiles.score} + ${pointsEarned}`,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, userId))
        .returning();
      updatedProfileRow = updated[0];
    } else {
      const existing = await db
        .select()
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      updatedProfileRow = existing[0];
    }

    const r = insertedResult[0];
    return res.status(201).json({
      testResult: {
        id: r.id,
        created_at: r.createdAt.toISOString(),
        topic: r.topic,
        score: r.score,
        total_questions: r.totalQuestions,
        user_id: r.userId,
      },
      profile: updatedProfileRow
        ? {
            id: updatedProfileRow.id,
            username: updatedProfileRow.username,
            avatar_url: updatedProfileRow.avatarUrl,
            score: updatedProfileRow.score,
          }
        : null,
    });
  } catch (error: any) {
    console.error('Error saving test result:', error);
    return res.status(500).json({ error: 'Failed to save test result.' });
  }
});

// ==========================================
// COMMUNITY POSTS ROUTES (Neon PostgreSQL)
// ==========================================

apiRouter.get('/posts', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await db
      .select({
        id: posts.id,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        content: posts.content,
        userId: posts.userId,
        profileId: profiles.id,
        username: profiles.username,
        avatarUrl: profiles.avatarUrl,
        score: profiles.score,
      })
      .from(posts)
      .leftJoin(profiles, eq(posts.userId, profiles.id))
      .orderBy(desc(posts.createdAt));

    const formattedPosts = rows.map((row) => ({
      id: row.id,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      content: row.content,
      user_id: row.userId,
      profiles: row.profileId
        ? {
            id: row.profileId,
            username: row.username,
            avatar_url: row.avatarUrl,
            score: row.score ?? 0,
          }
        : null,
    }));

    return res.json({ posts: formattedPosts });
  } catch (error: any) {
    console.error('Error fetching posts from Neon:', error);
    return res.status(500).json({ error: 'Failed to load community posts.' });
  }
});

apiRouter.post('/posts', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { content } = req.body || {};

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Post content cannot be empty.' });
    }
    if (content.trim().length > 5000) {
      return res.status(400).json({ error: 'Post content is too long (max 5000 characters).' });
    }

    const inserted = await db
      .insert(posts)
      .values({
        userId,
        content: content.trim(),
      })
      .returning();

    const authorProfile = await ensureUserProfile(userId, req.user!.email);
    const newPost = inserted[0];

    return res.status(201).json({
      post: {
        id: newPost.id,
        created_at: newPost.createdAt.toISOString(),
        updated_at: newPost.updatedAt.toISOString(),
        content: newPost.content,
        user_id: newPost.userId,
        profiles: authorProfile,
      },
    });
  } catch (error: any) {
    console.error('Error creating post in Neon:', error);
    return res.status(500).json({ error: 'Failed to create post.' });
  }
});

apiRouter.put('/posts/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const postId = String(req.params.id);
    const { content } = req.body || {};

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Post content cannot be empty.' });
    }

    const existing = await db
      .select()
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    if (existing[0].userId !== userId) {
      return res.status(403).json({ error: 'You are only authorized to edit your own posts.' });
    }

    const updated = await db
      .update(posts)
      .set({
        content: content.trim(),
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId))
      .returning();

    const authorProfile = await ensureUserProfile(userId, req.user!.email);
    const updatedPost = updated[0];

    return res.json({
      post: {
        id: updatedPost.id,
        created_at: updatedPost.createdAt.toISOString(),
        updated_at: updatedPost.updatedAt.toISOString(),
        content: updatedPost.content,
        user_id: updatedPost.userId,
        profiles: authorProfile,
      },
    });
  } catch (error: any) {
    console.error('Error updating post in Neon:', error);
    return res.status(500).json({ error: 'Failed to update post.' });
  }
});

apiRouter.delete('/posts/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const postId = String(req.params.id);

    const existing = await db
      .select()
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    if (existing[0].userId !== userId) {
      return res.status(403).json({ error: 'You are only authorized to delete your own posts.' });
    }

    await db.delete(posts).where(eq(posts.id, postId));
    return res.json({ success: true, id: postId });
  } catch (error: any) {
    console.error('Error deleting post in Neon:', error);
    return res.status(500).json({ error: 'Failed to delete post.' });
  }
});

// ==========================================
// GEMINI AI ROUTES & FAST QUESTION POOL ENGINE (Server-Side Only)
// ==========================================

let cachedGenAIClient: GoogleGenAI | null = null;
function getGenAIClient(): GoogleGenAI {
  if (cachedGenAIClient) return cachedGenAIClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  cachedGenAIClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return cachedGenAIClient;
}

const FAST_GEMINI_MODEL = 'gemini-2.5-flash';

async function generateFastContent(
  ai: GoogleGenAI,
  params: Omit<Parameters<typeof ai.models.generateContent>[0], 'model'>
): Promise<GenerateContentResponse> {
  return await ai.models.generateContent({
    ...params,
    model: FAST_GEMINI_MODEL,
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      ...params.config,
    },
  });
}

// Hot in-memory cache backed by Neon PostgreSQL public.gemini_question_pool
const memoryQuestionPool = new Map<string, any[]>();
const hydratedPoolKeys = new Set<string>();
const inFlightGenerations = new Map<string, Promise<any[]>>();
const backgroundReplenishingKeys = new Set<string>();

function getPoolKey(kind: 'practice' | 'voice', topic: string, difficulty = 'Medium'): string {
  return `${kind}::${topic.trim()}::${difficulty.trim()}`;
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function hydratePoolFromNeon(
  kind: 'practice' | 'voice',
  topic: string,
  difficulty = 'Medium'
): Promise<any[]> {
  const key = getPoolKey(kind, topic, difficulty);
  if (hydratedPoolKeys.has(key)) {
    return memoryQuestionPool.get(key) || [];
  }

  try {
    const rows = await db
      .select()
      .from(geminiQuestionPool)
      .where(
        and(
          eq(geminiQuestionPool.kind, kind),
          eq(geminiQuestionPool.topic, topic.trim()),
          eq(geminiQuestionPool.difficulty, difficulty.trim())
        )
      )
      .orderBy(desc(geminiQuestionPool.createdAt))
      .limit(60);

    const existingMem = memoryQuestionPool.get(key) || [];
    const seenTexts = new Set(existingMem.map((q) => String(q.question || '').trim().toLowerCase()));
    const combined = [...existingMem];

    for (const row of rows) {
      const qData = row.questionData as any;
      if (qData && typeof qData.question === 'string') {
        const norm = qData.question.trim().toLowerCase();
        if (!seenTexts.has(norm)) {
          seenTexts.add(norm);
          combined.push(qData);
        }
      }
    }

    memoryQuestionPool.set(key, combined);
    hydratedPoolKeys.add(key);
    return combined;
  } catch (err) {
    console.warn('Warning hydrating question pool from Neon:', err);
    return memoryQuestionPool.get(key) || [];
  }
}

async function persistQuestionsToPool(
  kind: 'practice' | 'voice',
  topic: string,
  difficulty: string,
  newQuestions: any[]
): Promise<void> {
  if (!Array.isArray(newQuestions) || newQuestions.length === 0) return;

  const key = getPoolKey(kind, topic, difficulty);
  const current = memoryQuestionPool.get(key) || [];
  const seen = new Set(current.map((q) => String(q.question || '').trim().toLowerCase()));
  const toInsert: {
    kind: string;
    topic: string;
    difficulty: string;
    questionText: string;
    questionData: any;
  }[] = [];

  for (const q of newQuestions) {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) continue;
    const norm = q.question.trim().toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      current.push(q);
      toInsert.push({
        kind,
        topic: topic.trim(),
        difficulty: difficulty.trim(),
        questionText: q.question.trim(),
        questionData: q,
      });
    }
  }

  memoryQuestionPool.set(key, current);

  if (toInsert.length > 0) {
    try {
      await db
        .insert(geminiQuestionPool)
        .values(toInsert)
        .onConflictDoNothing();
    } catch (err) {
      console.warn('Failed to persist Gemini questions to Neon pool:', err);
    }
  }
}

async function generatePracticeBatchFromGemini(
  topic: string,
  count: number,
  avoidQuestions: string[] = []
): Promise<any[]> {
  const key = `gen::practice::${topic}::${count}`;
  const existingInFlight = inFlightGenerations.get(key);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = (async () => {
    try {
      const ai = getGenAIClient();
      const avoidClause =
        avoidQuestions.length > 0
          ? ` Avoid repeating these exact questions: ${avoidQuestions
              .slice(0, 10)
              .map((q) => `"${q.slice(0, 80)}"`)
              .join(', ')}.`
          : '';

      const response = await generateFastContent(ai, {
        contents: `Generate ${count} distinct multiple-choice aptitude questions about "${topic}". For each question, provide a clear question text, 4 options, the exact correctAnswer (matching one of the 4 options), and a concise explanation.${avoidClause}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                correctAnswer: { type: Type.STRING },
                explanation: { type: Type.STRING },
              },
              required: ['question', 'options', 'correctAnswer', 'explanation'],
            },
          },
        },
      });

      const parsed = JSON.parse((response.text || '[]').trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        await persistQuestionsToPool('practice', topic, 'Medium', parsed);
        return parsed;
      }
      return [];
    } finally {
      inFlightGenerations.delete(key);
    }
  })();

  inFlightGenerations.set(key, promise);
  return promise;
}

async function generateVoiceBatchFromGemini(
  topic: string,
  difficulty: string,
  count: number,
  avoidQuestions: string[] = []
): Promise<any[]> {
  const key = `gen::voice::${topic}::${difficulty}::${count}`;
  const existingInFlight = inFlightGenerations.get(key);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = (async () => {
    try {
      const ai = getGenAIClient();
      const avoidClause =
        avoidQuestions.length > 0
          ? ` Avoid repeating these exact questions: ${avoidQuestions
              .slice(0, 10)
              .map((q) => `"${q.slice(0, 80)}"`)
              .join(', ')}.`
          : '';

      const response = await generateFastContent(ai, {
        contents: `Generate ${count} distinct aptitude questions for a voice test on the topic "${topic}" with ${difficulty} difficulty. The questions should be clear and concise. The answers should be simple, one-or-two-word answers that are easy to say.${avoidClause}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                answer: { type: Type.STRING },
              },
              required: ['question', 'answer'],
            },
          },
        },
      });

      const parsed = JSON.parse((response.text || '[]').trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        await persistQuestionsToPool('voice', topic, difficulty, parsed);
        return parsed;
      }
      return [];
    } finally {
      inFlightGenerations.delete(key);
    }
  })();

  inFlightGenerations.set(key, promise);
  return promise;
}

function triggerBackgroundPoolReplenish(
  kind: 'practice' | 'voice',
  topic: string,
  difficulty = 'Medium',
  batchSize = 5
) {
  const poolKey = getPoolKey(kind, topic, difficulty);
  if (backgroundReplenishingKeys.has(poolKey)) return;
  backgroundReplenishingKeys.add(poolKey);

  setImmediate(async () => {
    try {
      const currentPool = memoryQuestionPool.get(poolKey) || [];
      const existingTexts = currentPool.map((q) => String(q.question || ''));
      if (kind === 'practice') {
        await generatePracticeBatchFromGemini(topic, batchSize, existingTexts);
      } else {
        await generateVoiceBatchFromGemini(topic, difficulty, batchSize, existingTexts);
      }
    } catch (err) {
      console.warn(`Background pool replenish warning for ${poolKey}:`, err);
    } finally {
      backgroundReplenishingKeys.delete(poolKey);
    }
  });
}

apiRouter.post('/gemini/questions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { topic, count = 5, excludeQuestions = [], allowPartial = false } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'Topic is required.' });
    }

    const desiredCount = Math.max(1, Math.min(15, Number(count) || 5));
    const excludeSet = new Set(
      (Array.isArray(excludeQuestions) ? excludeQuestions : []).map((q) =>
        String(q || '').trim().toLowerCase()
      )
    );

    const poolItems = await hydratePoolFromNeon('practice', topic, 'Medium');
    const unseenItems = poolItems.filter(
      (q) => !excludeSet.has(String(q.question || '').trim().toLowerCase())
    );

    if (unseenItems.length >= desiredCount) {
      const selected = shuffleArray(unseenItems).slice(0, desiredCount);
      if (unseenItems.length < desiredCount * 2 || poolItems.length < 20) {
        triggerBackgroundPoolReplenish('practice', topic, 'Medium', 5);
      }
      return res.json({ questions: selected, cached: true });
    }

    if (poolItems.length >= desiredCount) {
      const remainderNeeded = desiredCount - unseenItems.length;
      const seenItems = poolItems.filter((q) =>
        excludeSet.has(String(q.question || '').trim().toLowerCase())
      );
      const selected = [
        ...shuffleArray(unseenItems),
        ...shuffleArray(seenItems).slice(0, remainderNeeded),
      ];
      triggerBackgroundPoolReplenish('practice', topic, 'Medium', 5);
      return res.json({ questions: selected, cached: true });
    }

    if (allowPartial && poolItems.length > 0) {
      triggerBackgroundPoolReplenish('practice', topic, 'Medium', 5);
      return res.json({ questions: shuffleArray(poolItems).slice(0, desiredCount), partial: true });
    }

    const generated = await generatePracticeBatchFromGemini(
      topic,
      desiredCount,
      poolItems.map((q) => String(q.question || ''))
    );

    // Replenish an additional batch in the background so future tests are instant
    triggerBackgroundPoolReplenish('practice', topic, 'Medium', 5);

    return res.json({ questions: generated.slice(0, desiredCount), cached: false });
  } catch (error: any) {
    console.error('Error generating aptitude questions with Gemini:', error);
    return res.status(500).json({ error: 'Failed to generate aptitude questions.', questions: [] });
  }
});

apiRouter.post('/gemini/voice-questions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      topic,
      difficulty = 'Medium',
      count = 5,
      excludeQuestions = [],
      allowPartial = false,
    } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'Topic is required.' });
    }

    const desiredCount = Math.max(1, Math.min(15, Number(count) || 5));
    const excludeSet = new Set(
      (Array.isArray(excludeQuestions) ? excludeQuestions : []).map((q) =>
        String(q || '').trim().toLowerCase()
      )
    );

    const poolItems = await hydratePoolFromNeon('voice', topic, difficulty);
    const unseenItems = poolItems.filter(
      (q) => !excludeSet.has(String(q.question || '').trim().toLowerCase())
    );

    if (unseenItems.length >= desiredCount) {
      const selected = shuffleArray(unseenItems).slice(0, desiredCount);
      if (unseenItems.length < desiredCount * 2 || poolItems.length < 20) {
        triggerBackgroundPoolReplenish('voice', topic, difficulty, 5);
      }
      return res.json({ questions: selected, cached: true });
    }

    if (poolItems.length >= desiredCount) {
      const remainderNeeded = desiredCount - unseenItems.length;
      const seenItems = poolItems.filter((q) =>
        excludeSet.has(String(q.question || '').trim().toLowerCase())
      );
      const selected = [
        ...shuffleArray(unseenItems),
        ...shuffleArray(seenItems).slice(0, remainderNeeded),
      ];
      triggerBackgroundPoolReplenish('voice', topic, difficulty, 5);
      return res.json({ questions: selected, cached: true });
    }

    if (allowPartial && unseenItems.length > 0) {
      triggerBackgroundPoolReplenish('voice', topic, difficulty, Math.max(5, desiredCount));
      return res.json({
        questions: shuffleArray(unseenItems).slice(0, desiredCount),
        partial: true,
      });
    }

    const generated = await generateVoiceBatchFromGemini(
      topic,
      difficulty,
      desiredCount,
      poolItems.map((q) => String(q.question || ''))
    );

    triggerBackgroundPoolReplenish('voice', topic, difficulty, 5);

    return res.json({ questions: generated.slice(0, desiredCount), cached: false });
  } catch (error: any) {
    console.error('Error generating voice test questions:', error);
    return res.status(500).json({ error: 'Failed to generate voice test questions.', questions: [] });
  }
});

// Non-blocking background warmup endpoint so Practice & Voice Test pools stay pre-populated
apiRouter.post('/gemini/warmup', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { topic, difficulty = 'Medium', kind = 'both' } = req.body || {};
    res.json({ status: 'warming' });

    setImmediate(async () => {
      try {
        const practiceTopics = topic
          ? [String(topic)]
          : [
              'Quantitative Aptitude',
              'Logical Reasoning',
              'Verbal Ability',
              'General Knowledge',
              'Data Interpretation',
            ];

        if (kind === 'practice' || kind === 'both') {
          for (const t of practiceTopics) {
            const items = await hydratePoolFromNeon('practice', t, 'Medium');
            if (items.length < 10) {
              await generatePracticeBatchFromGemini(t, 5, items.map((q) => q.question));
            }
          }
        }

        if (kind === 'voice' || kind === 'both') {
          const voiceTopics = topic
            ? [String(topic)]
            : ['Quantitative Aptitude', 'Verbal Ability', 'General Knowledge'];
          for (const vt of voiceTopics) {
            const items = await hydratePoolFromNeon('voice', vt, difficulty);
            if (items.length < 10) {
              await generateVoiceBatchFromGemini(vt, difficulty, 5, items.map((q) => q.question));
            }
          }
        }
      } catch (err) {
        console.warn('Warmup background warning:', err);
      }
    });
  } catch {
    res.json({ status: 'skipped' });
  }
});

apiRouter.post('/gemini/mentor', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { prompt, history = [], performanceData } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const ai = getGenAIClient();
    let systemInstruction =
      "You are AptiPro's AI Mentor. You are an expert in aptitude tests, including quantitative, logical, and verbal reasoning. Your tone is encouraging, helpful, and clear. Help users understand concepts and solve problems step-by-step. Do not answer questions outside of this scope.";

    if (performanceData && typeof performanceData === 'string') {
      systemInstruction += `\n\nAdditionally, use the user's past performance data to provide personalized advice and suggestions. Here is a summary of their performance:\n${performanceData}`;
    }

    const chat = ai.chats.create({
      model: FAST_GEMINI_MODEL,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingBudget: 0 },
      },
      history: Array.isArray(history) ? history : [],
    });
    const response = await chat.sendMessage({ message: prompt });
    const responseText = response.text || '';

    return res.json({ text: responseText });
  } catch (error: any) {
    console.error('Error getting AI mentor response:', error);
    return res.status(500).json({
      text: 'Sorry, I encountered an error. Please try again.',
      error: 'Failed to get AI mentor response.',
    });
  }
});

const spokenEvalCache = new Map<string, { isCorrect: boolean; feedback: string }>();

function normalizeAnswerText(val: string): string {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\b(the|answer|is|it|its|equals|equal|to|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

apiRouter.post('/gemini/evaluate-spoken', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { question, correctAnswer, spokenAnswer } = req.body || {};
    if (!question || !correctAnswer || typeof spokenAnswer !== 'string') {
      return res.status(400).json({ error: 'question, correctAnswer, and spokenAnswer are required.' });
    }

    const normCorrect = normalizeAnswerText(String(correctAnswer));
    const normSpoken = normalizeAnswerText(String(spokenAnswer));

    // Instant exact/normalized match fast-path (0ms)
    if (normCorrect && normSpoken && (normSpoken === normCorrect || normSpoken.includes(normCorrect))) {
      return res.json({
        isCorrect: true,
        feedback: `Correct! "${correctAnswer}" is the right answer.`,
      });
    }

    const cacheKey = `${question.trim().toLowerCase()}||${normCorrect}||${normSpoken}`;
    const cachedEval = spokenEvalCache.get(cacheKey);
    if (cachedEval) {
      return res.json(cachedEval);
    }

    const ai = getGenAIClient();
    const prompt = `Question: "${question}"
Correct Answer: "${correctAnswer}"
User's Spoken Answer: "${spokenAnswer}"

Is the user's spoken answer correct? Be flexible with minor variations (e.g., 'forty five' vs '45', extra words like 'the answer is...'). Respond in JSON format with two keys: "isCorrect" (boolean) and "feedback" (a brief string explaining why, or just confirming correctness).`;

    const response = await generateFastContent(ai, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isCorrect: { type: Type.BOOLEAN },
            feedback: { type: Type.STRING },
          },
          required: ['isCorrect', 'feedback'],
        },
      },
    });

    const jsonString = (response.text || '{}').trim();
    const result = JSON.parse(jsonString);
    spokenEvalCache.set(cacheKey, result);
    return res.json(result);
  } catch (error: any) {
    console.error('Error evaluating spoken answer:', error);
    const { correctAnswer = '', spokenAnswer = '' } = req.body || {};
    if (
      spokenAnswer &&
      correctAnswer &&
      String(spokenAnswer).toLowerCase().includes(String(correctAnswer).toLowerCase())
    ) {
      return res.json({ isCorrect: true, feedback: 'Correct!' });
    }
    return res.json({
      isCorrect: false,
      feedback: `Sorry, an error occurred during evaluation. The expected answer is similar to "${correctAnswer}".`,
    });
  }
});
