import { User, Profile, TestResult, CommunityPost } from '../types';

const SESSION_STORAGE_KEY = 'aptipro_neon_session_token';

// Fallback token for cross-origin iframe environments where browsers block third-party cookies.
// Primary session persistence uses HTTP-only cookies managed by the backend + Neon Auth.
let inMemoryToken: string | null = (() => {
  try {
    return typeof window !== 'undefined' ? sessionStorage.getItem(SESSION_STORAGE_KEY) : null;
  } catch {
    return null;
  }
})();

export function setInMemorySessionToken(token: string | null) {
  inMemoryToken = token;
  try {
    if (typeof window !== 'undefined') {
      if (token) {
        sessionStorage.setItem(SESSION_STORAGE_KEY, token);
      } else {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage restriction errors
  }
}

export async function apiFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }

  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(data.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }

  return data as T;
}

// --- Neon Auth Client Helpers ---
export async function fetchCurrentUser(): Promise<{
  user: User | null;
  profile: Profile | null;
}> {
  // Check if returning from Neon Auth OAuth with a session verifier
  const searchParams = new URLSearchParams(window.location.search);
  const hashQuery = window.location.hash.includes('?')
    ? window.location.hash.split('?')[1]
    : '';
  const hashParams = new URLSearchParams(hashQuery);
  const verifier =
    searchParams.get('neon_auth_session_verifier') ||
    hashParams.get('neon_auth_session_verifier');

  if (verifier) {
    try {
      let sessionToken: string | null = null;
      const { neonAuthUrl } = await apiFetch<{ neonAuthUrl: string }>('/auth/config');
      if (neonAuthUrl) {
        try {
          const gsRes = await fetch(
            `${neonAuthUrl}/get-session?neon_auth_session_verifier=${encodeURIComponent(verifier)}`,
            { credentials: 'include' }
          );
          if (gsRes.ok) {
            const gsData = await gsRes.json().catch(() => null);
            sessionToken = gsData?.session?.token || gsData?.token || null;
          }
        } catch {
          // Will fallback to verifier lookup in /auth/neon-sync
        }
      }

      const synced = await apiFetch<{
        user: User;
        profile: Profile;
        sessionToken: string;
      }>('/auth/neon-sync', {
        method: 'POST',
        body: JSON.stringify({ sessionToken, verifier }),
      });

      if (synced?.sessionToken) {
        setInMemorySessionToken(synced.sessionToken);
        if (window.opener) {
          window.opener.postMessage(
            {
              type: 'NEON_OAUTH_SUCCESS',
              sessionToken: synced.sessionToken,
              user: synced.user,
              profile: synced.profile,
            },
            '*'
          );
          window.close();
        }
        const cleanUrl = window.location.pathname + window.location.hash.split('?')[0];
        window.history.replaceState(null, '', cleanUrl);
        return { user: synced.user, profile: synced.profile };
      }
    } catch (err) {
      console.error('Error exchanging Neon Auth OAuth verifier:', err);
    }
  }

  const res = await apiFetch<{
    user: User | null;
    profile: Profile | null;
    sessionToken?: string;
  }>('/auth/me');
  if (res.sessionToken) {
    setInMemorySessionToken(res.sessionToken);
  }
  return res;
}

export async function signUpWithEmail(
  email: string,
  password: string
): Promise<{ user: User; profile: Profile; sessionToken?: string }> {
  const res = await apiFetch<{ user: User; profile: Profile; sessionToken?: string }>(
    '/auth/signup',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }
  );
  if (res.sessionToken) {
    setInMemorySessionToken(res.sessionToken);
  }
  return res;
}

export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: User; profile: Profile; sessionToken?: string }> {
  const res = await apiFetch<{ user: User; profile: Profile; sessionToken?: string }>(
    '/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }
  );
  if (res.sessionToken) {
    setInMemorySessionToken(res.sessionToken);
  }
  return res;
}

export async function signOutUser(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
  setInMemorySessionToken(null);
}

export async function requestPasswordReset(
  email: string
): Promise<{ message: string; resetToken?: string }> {
  return apiFetch('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function submitPasswordReset(
  password: string,
  token?: string | null
): Promise<{ message: string }> {
  return apiFetch<{ message: string }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ password, token }),
  });
}

export async function syncNeonAuthSession(
  sessionToken: string,
  verifier?: string | null
): Promise<{ user: User; profile: Profile; sessionToken: string }> {
  const synced = await apiFetch<{
    user: User;
    profile: Profile;
    sessionToken: string;
  }>('/auth/neon-sync', {
    method: 'POST',
    body: JSON.stringify({ sessionToken, verifier }),
  });
  setInMemorySessionToken(synced.sessionToken);
  return synced;
}

export async function deleteAccount(): Promise<void> {
  await apiFetch('/auth/account', { method: 'DELETE' });
  setInMemorySessionToken(null);
}

// --- Profile & Avatar Storage API ---
export async function fetchUserProfile(
  userId: string
): Promise<{ profile: Profile; recentPosts: CommunityPost[] }> {
  return apiFetch(`/profiles/${encodeURIComponent(userId)}`);
}

export async function updateMyProfile(updates: {
  username?: string;
  avatar_url?: string | null;
}): Promise<{ profile: Profile }> {
  return apiFetch('/profiles/me', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function compressAndUploadAvatar(
  file: File
): Promise<{ publicUrl: string; profile: Profile }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 256;
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(reader.result as string);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Failed to decode selected image.'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });

  return apiFetch('/storage/avatar', {
    method: 'POST',
    body: JSON.stringify({
      avatarDataUrl: dataUrl,
      fileName: file.name,
      contentType: file.type,
    }),
  });
}

// --- Leaderboard API ---
export async function fetchLeaderboard(): Promise<{
  leaderboard: (Profile & { rank: number })[];
  userRank: number;
}> {
  return apiFetch('/leaderboard');
}

// --- Test Results API ---
export async function fetchWeeklyTestResults(): Promise<{ results: TestResult[] }> {
  return apiFetch('/test-results');
}

export async function recordTestResult(
  topic: string,
  score: number,
  totalQuestions: number
): Promise<{ testResult: TestResult; profile: Profile | null }> {
  return apiFetch('/test-results', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      score,
      total_questions: totalQuestions,
    }),
  });
}

// --- Community Posts API ---
export async function fetchAllPosts(): Promise<{ posts: CommunityPost[] }> {
  return apiFetch('/posts');
}

export async function createNewPost(
  content: string
): Promise<{ post: CommunityPost }> {
  return apiFetch('/posts', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export async function updateExistingPost(
  postId: string,
  content: string
): Promise<{ post: CommunityPost }> {
  return apiFetch(`/posts/${encodeURIComponent(postId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export async function deleteExistingPost(postId: string): Promise<{ success: boolean }> {
  return apiFetch(`/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
  });
}
