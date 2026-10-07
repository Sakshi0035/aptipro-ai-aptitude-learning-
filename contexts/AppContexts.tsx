import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { User, Session, Profile } from '../types';
import { fetchCurrentUser, signOutUser } from '../services/apiClient';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  setProfile: React.Dispatch<React.SetStateAction<Profile | null>>;
  setAuthSession: (user: User | null, profile: Profile | null) => void;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  loading: boolean;
  isPasswordRecovery: boolean;
  setIsPasswordRecovery: React.Dispatch<React.SetStateAction<boolean>>;
  passwordResetToken: string | null;
  setPasswordResetToken: React.Dispatch<React.SetStateAction<string | null>>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const [passwordResetToken, setPasswordResetToken] = useState<string | null>(null);

  const setAuthSession = useCallback((nextUser: User | null, nextProfile: Profile | null) => {
    setUser(nextUser);
    setSession(nextUser ? { user: nextUser } : null);
    setProfile(nextProfile);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const { user: currentUser, profile: currentProfile } = await fetchCurrentUser();
      setAuthSession(currentUser, currentProfile);
    } catch (error) {
      console.error('Error checking auth session:', error);
      setAuthSession(null, null);
    } finally {
      setLoading(false);
    }
  }, [setAuthSession]);

  useEffect(() => {
    // Check if URL contains a password reset token
    const checkUrlForResetToken = () => {
      const hash = window.location.hash || '';
      const search = window.location.search || '';
      const pathname = window.location.pathname || '';
      let token: string | null = null;

      if (hash.includes('token=')) {
        const queryPart = hash.split('?')[1] || hash.substring(1);
        const params = new URLSearchParams(queryPart);
        token = params.get('token');
      } else if (search.includes('token=')) {
        const params = new URLSearchParams(search);
        token = params.get('token');
      } else if (pathname === '/reset-password') {
        const params = new URLSearchParams(search);
        token = params.get('token');
      }

      if (token) {
        setPasswordResetToken(token);
        setIsPasswordRecovery(true);
      }
    };

    checkUrlForResetToken();
    window.addEventListener('hashchange', checkUrlForResetToken);
    refreshSession();

    return () => {
      window.removeEventListener('hashchange', checkUrlForResetToken);
    };
  }, [refreshSession]);

  const signOut = async () => {
    setIsPasswordRecovery(false);
    setPasswordResetToken(null);
    await signOutUser();
    setAuthSession(null, null);
  };

  const value: AuthContextType = {
    session,
    user,
    profile,
    setProfile,
    setAuthSession,
    refreshSession,
    signOut,
    loading,
    isPasswordRecovery,
    setIsPasswordRecovery,
    passwordResetToken,
    setPasswordResetToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

// --- Theme Context ---
type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const savedTheme = localStorage.getItem('theme') as Theme;
      if (savedTheme) {
        return savedTheme;
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  const toggleTheme = () => {
    setTheme((prevTheme) => {
      const newTheme = prevTheme === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', newTheme);
      return newTheme;
    });
  };

  const value = { theme, toggleTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
