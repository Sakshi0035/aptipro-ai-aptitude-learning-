import React, { useContext, useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AppContexts';
import { ThemeProvider, useTheme } from './contexts/AppContexts';
import AuthPage from './components/Auth';
import Dashboard from './components/Dashboard';
import Practice from './components/Practice';
import VoiceTest from './components/VoiceTest';
import Leaderboard from './components/Leaderboard';
import Community from './components/Community';
import AIMentor from './components/AIMentor';
import Profile from './components/Profile';
import Avatar from './components/Avatar';
import PasswordReset from './components/PasswordReset';
import { SunIcon, MoonIcon, MenuIcon, XIcon, FireIcon, BrainCircuitIcon, UsersIcon, TrophyIcon, MicVocalIcon, MessageSquareIcon, UserCircleIcon, LogOutIcon } from './components/Icons';

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <HashRouter>
          <MainApp />
        </HashRouter>
      </AuthProvider>
    </ThemeProvider>
  );
};

const MainApp: React.FC = () => {
  const { theme } = useTheme();
  const { isPasswordRecovery } = useAuth();

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  if (isPasswordRecovery) {
    return <PasswordReset />;
  }

  return (
    <div className="min-h-screen font-sans text-gray-800 bg-gray-50 dark:bg-gray-900 dark:text-gray-200">
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/reset-password" element={<PasswordReset />} />
        <Route path="/*" element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        } />
      </Routes>
    </div>
  );
}

const ProtectedRoute: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const { session, loading } = useAuth();
  
  if (loading) {
    return (
        <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
            <div className="w-16 h-16 border-4 border-t-transparent border-fire-orange-start rounded-full animate-spin"></div>
        </div>
    );
  }

  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  return children;
};

const AppLayout: React.FC = () => {
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const { user, profile, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const navItems = [
    { name: 'Dashboard', path: '/dashboard', icon: <FireIcon /> },
    { name: 'Practice', path: '/practice', icon: <BrainCircuitIcon /> },
    { name: 'Voice Test', path: '/voice-test', icon: <MicVocalIcon /> },
    { name: 'Leaderboard', path: '/leaderboard', icon: <TrophyIcon /> },
    { name: 'Community', path: '/community', icon: <UsersIcon /> },
    { name: 'AI Mentor', path: '/mentor', icon: <MessageSquareIcon /> },
    { name: 'Profile', path: '/profile', icon: <UserCircleIcon /> },
  ];

  const location = useLocation();

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 bg-white dark:bg-gray-800 shadow-lg transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} transition-transform duration-300 ease-in-out md:relative md:translate-x-0`}>
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-fire-orange-start to-fire-red-end">AptiPro</h1>
            <button onClick={() => setSidebarOpen(false)} className="md:hidden text-gray-600 dark:text-gray-400">
                <XIcon />
            </button>
        </div>
        <nav className="mt-4 flex flex-col justify-between h-[calc(100%-8rem)]">
          <ul>
            {navItems.map(item => (
              <li key={item.name} className="px-2">
                <Link to={item.path} onClick={closeSidebar} className={`flex items-center p-3 my-1 rounded-lg transition-colors ${location.pathname.startsWith(item.path) ? 'bg-gradient-to-r from-orange-100 to-red-100 text-fire-orange-start dark:from-gray-700 dark:to-gray-700 dark:text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                  <span className="mr-3">{item.icon}</span>
                  <span className="font-medium">{item.name}</span>
                </Link>
              </li>
            ))}
          </ul>
           <div className="p-4 border-t border-gray-200 dark:border-gray-700">
              <p className="text-xs text-center text-gray-400 dark:text-gray-500 mb-2">AptiPro is a freemium service.</p>
              <button onClick={signOut} className="flex items-center w-full p-3 rounded-lg text-left text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
                <LogOutIcon />
                <span className="ml-3 font-medium">Logout</span>
              </button>
            </div>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between p-4 bg-white dark:bg-gray-800 shadow-md md:justify-end">
          <button onClick={() => setSidebarOpen(true)} className="text-gray-600 dark:text-gray-400 md:hidden">
            <MenuIcon />
          </button>
          <div className="flex items-center space-x-4">
            <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300">
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <div className="flex items-center space-x-2">
              <Avatar avatarUrl={profile?.avatar_url} name={profile?.username || user?.email} size={32} />
              <span className="hidden sm:inline font-medium">{profile?.username || user?.email?.split('@')[0]}</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-gray-100 dark:bg-gray-900 p-4 sm:p-6 lg:p-8">
            <Routes>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/practice" element={<Practice />} />
                <Route path="/practice/:topic" element={<Practice />} />
                <Route path="/voice-test" element={<VoiceTest />} />
                <Route path="/leaderboard" element={<Leaderboard />} />
                <Route path="/community" element={<Community />} />
                <Route path="/mentor" element={<AIMentor />} />
                <Route path="/profile/:userId" element={<Profile />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
        </main>
      </div>
    </div>
  );
};

export default App;
