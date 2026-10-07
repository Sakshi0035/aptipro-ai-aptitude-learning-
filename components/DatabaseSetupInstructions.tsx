import React from 'react';
import { WarningIcon } from './Icons';

type Feature = 'weekly_progress' | 'leaderboard' | 'community';

interface Props {
  feature: Feature;
  error: string;
}

const CodeBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <pre className="mt-2 p-3 bg-gray-100 dark:bg-gray-900 rounded-md text-xs text-left overflow-x-auto">
    <code>{children}</code>
  </pre>
);

const instructions: Record<Feature, { title: string; steps: string[] }> = {
  weekly_progress: {
    title: 'Practice & Progress Features (Neon PostgreSQL)',
    steps: [
      `-- Verify DATABASE_URL is configured in your environment variables.
-- Tables are automatically initialized in Neon PostgreSQL linked to Neon Auth:
CREATE TABLE IF NOT EXISTS public.test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  score INT NOT NULL,
  total_questions INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    ],
  },
  leaderboard: {
    title: 'Leaderboard Feature (Neon PostgreSQL)',
    steps: [
      `-- Verify DATABASE_URL is configured in your environment variables.
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  username TEXT,
  avatar_url TEXT,
  score INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    ],
  },
  community: {
    title: 'Community & Posts Feature (Neon PostgreSQL)',
    steps: [
      `-- Verify DATABASE_URL is configured in your environment variables.
CREATE TABLE IF NOT EXISTS public.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    ],
  },
};

const DatabaseSetupInstructions: React.FC<Props> = ({ feature, error }) => {
  const info = instructions[feature];

  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
      <WarningIcon size={48} className="mb-4" />
      <h3 className="font-bold text-lg">Database Connection Needed</h3>
      <p className="text-sm text-gray-600 dark:text-gray-300 max-w-md mx-auto">
        The &ldquo;{info.title}&rdquo; could not reach Neon PostgreSQL. Please verify that{' '}
        <code>DATABASE_URL</code> is set in your server environment variables.
      </p>
      <details className="mt-4 w-full max-w-lg text-left">
        <summary className="cursor-pointer font-semibold text-sm text-center">
          Show Neon Schema Reference
        </summary>
        <div className="mt-2 space-y-4">
          {info.steps.map((step, index) => (
            <CodeBlock key={index}>{step.trim()}</CodeBlock>
          ))}
        </div>
      </details>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">Error details: {error}</p>
    </div>
  );
};

export default DatabaseSetupInstructions;
