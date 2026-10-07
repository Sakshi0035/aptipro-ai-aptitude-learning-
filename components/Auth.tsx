import React, { useState, FormEvent, useEffect } from 'react';
import { useAuth } from '../contexts/AppContexts';
import { Navigate } from 'react-router-dom';
import { GoogleIcon } from './Icons';
import AuthSetupInstructions from './AuthSetupInstructions';
import {
  signInWithEmail,
  signUpWithEmail,
  requestPasswordReset,
  syncNeonAuthSession,
  setInMemorySessionToken,
} from '../services/apiClient';

const AuthPage: React.FC = () => {
  const {
    session,
    setAuthSession,
    setIsPasswordRecovery,
    setPasswordResetToken,
  } = useAuth();
  const [view, setView] = useState<'login' | 'signup' | 'forgotPassword'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [authSetupError, setAuthSetupError] = useState<'oauth' | 'email' | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes('error_description') || hash.includes('error=')) {
      const queryPart = hash.includes('?') ? hash.split('?')[1] : hash.substring(1);
      const params = new URLSearchParams(queryPart);
      const errorDescription = decodeURIComponent(
        params.get('error_description') || params.get('error') || ''
      );
      if (errorDescription) {
        setError(`Google Auth Error: ${errorDescription}`);
      }
      window.history.replaceState(null, '', window.location.pathname + '#/auth');
    }

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === 'NEON_OAUTH_SUCCESS' && event.data?.sessionToken) {
        try {
          setLoading(true);
          setError(null);
          setInMemorySessionToken(event.data.sessionToken);
          if (event.data.user && event.data.profile) {
            setAuthSession(event.data.user, event.data.profile);
          } else {
            const synced = await syncNeonAuthSession(event.data.sessionToken);
            setAuthSession(synced.user, synced.profile);
          }
        } catch (err: any) {
          setError(err.message || 'Failed to complete Google Sign-In.');
        } finally {
          setLoading(false);
        }
      } else if (event.data?.type === 'NEON_OAUTH_ERROR') {
        setLoading(false);
        setError(event.data.error || 'Google Sign-In failed.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [setAuthSession]);

  if (session) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleAuth = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    setAuthSetupError(null);

    try {
      if (view === 'login') {
        const res = await signInWithEmail(email, password);
        setAuthSession(res.user, res.profile);
      } else {
        const res = await signUpWithEmail(email, password);
        setAuthSession(res.user, res.profile);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await requestPasswordReset(email);
      setPasswordResetToken(null);
      setIsPasswordRecovery(false);
      setMessage(res.message || 'Check your email for password reset instructions.');
    } catch (err: any) {
      setError(err.message || 'Failed to initiate password reset.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    setError(null);
    setMessage(null);
    setAuthSetupError(null);

    const popupUrl = `${window.location.origin}/api/auth/google/popup-start`;
    // Open popup synchronously inside user click handler so browser popup blockers never trigger
    const popup = window.open(
      popupUrl,
      'neon_google_oauth',
      'width=550,height=680,menubar=no,toolbar=no,location=no,status=no'
    );

    if (!popup) {
      // Only navigate current window if top-level; Google OAuth refuses to load inside an iframe
      const isInIframe = window.self !== window.top;
      if (!isInIframe) {
        window.location.href = popupUrl;
      } else {
        setError('Popup was blocked by your browser. Please allow popups for this site to Sign in with Google.');
      }
    }
  };

  const pageInfo = {
    login: {
      title: 'Sign in to continue your journey',
      button: 'Sign In',
      toggleText: "Don't have an account?",
      toggleLink: 'Sign Up',
    },
    signup: {
      title: 'Create an account to get started',
      button: 'Sign Up',
      toggleText: 'Already have an account?',
      toggleLink: 'Sign In',
    },
    forgotPassword: {
      title: 'Reset your password',
      button: 'Send Reset Instructions',
      toggleText: 'Remembered your password?',
      toggleLink: 'Sign In',
    },
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 animate-fade-in p-4">
      <div className="w-full max-w-md p-8 space-y-6 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl">
        <div className="text-center">
          <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-fire-orange-start to-fire-red-end">
            AptiPro
          </h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">{pageInfo[view].title}</p>
        </div>

        {authSetupError && <AuthSetupInstructions type={authSetupError} />}
        {error && (
          <div className="p-3 text-sm text-center text-red-800 bg-red-100 rounded-lg dark:bg-red-900 dark:text-red-300">
            {error}
          </div>
        )}
        {message && (
          <div className="p-3 text-sm text-center text-green-800 bg-green-100 rounded-lg dark:bg-green-900 dark:text-green-300">
            {message}
          </div>
        )}

        {view !== 'forgotPassword' && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center px-4 py-3 font-medium text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-600"
            >
              <GoogleIcon />
              <span className="ml-3">Sign in with Google</span>
            </button>
            <div className="relative flex items-center justify-center">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300 dark:border-gray-600"></div>
              </div>
              <div className="relative px-2 text-sm bg-white dark:bg-gray-800 text-gray-500">
                Or with email
              </div>
            </div>
          </div>
        )}

        <form
          className="space-y-6"
          onSubmit={view === 'forgotPassword' ? handlePasswordReset : handleAuth}
        >
          <div className="relative">
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="block w-full px-4 py-3 text-gray-900 bg-transparent border-2 border-gray-300 rounded-lg appearance-none dark:text-white dark:border-gray-600 focus:outline-none focus:ring-0 focus:border-fire-orange-start peer"
              placeholder=" "
            />
            <label
              htmlFor="email"
              className="absolute text-sm text-gray-500 dark:text-gray-400 duration-300 transform -translate-y-4 scale-75 top-2 z-10 origin-[0] bg-white dark:bg-gray-800 px-2 peer-focus:px-2 peer-focus:text-fire-orange-start peer-placeholder-shown:scale-100 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:top-1/2 peer-focus:top-2 peer-focus:scale-75 peer-focus:-translate-y-4 left-2"
            >
              Email address
            </label>
          </div>

          {view !== 'forgotPassword' && (
            <div className="relative">
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="block w-full px-4 py-3 text-gray-900 bg-transparent border-2 border-gray-300 rounded-lg appearance-none dark:text-white dark:border-gray-600 focus:outline-none focus:ring-0 focus:border-fire-orange-start peer"
                placeholder=" "
              />
              <label
                htmlFor="password"
                className="absolute text-sm text-gray-500 dark:text-gray-400 duration-300 transform -translate-y-4 scale-75 top-2 z-10 origin-[0] bg-white dark:bg-gray-800 px-2 peer-focus:px-2 peer-focus:text-fire-orange-start peer-placeholder-shown:scale-100 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:top-1/2 peer-focus:top-2 peer-focus:scale-75 peer-focus:-translate-y-4 left-2"
              >
                Password
              </label>
            </div>
          )}

          {view === 'login' && (
            <div className="flex justify-end text-sm">
              <button
                type="button"
                onClick={() => {
                  setView('forgotPassword');
                  setError(null);
                  setMessage(null);
                }}
                className="font-medium text-fire-orange-start hover:underline"
              >
                Forgot password?
              </button>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-3 font-semibold text-white bg-gradient-to-r from-fire-orange-start to-fire-red-end rounded-lg hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-fire-red-end transition-opacity disabled:opacity-50"
          >
            {loading ? 'Processing...' : pageInfo[view].button}
          </button>
        </form>

        <p className="text-sm text-center text-gray-600 dark:text-gray-400">
          {pageInfo[view].toggleText}
          <button
            type="button"
            onClick={() => {
              setView(view === 'login' ? 'signup' : 'login');
              setError(null);
              setMessage(null);
            }}
            className="ml-1 font-medium text-fire-orange-start hover:underline"
          >
            {pageInfo[view].toggleLink}
          </button>
        </p>
      </div>
    </div>
  );
};

export default AuthPage;
