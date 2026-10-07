import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as schema from './schema';

const envLocal = dotenv.config({ path: '.env.local' });
dotenv.config();
if (!process.env.DATABASE_URL && envLocal.parsed?.DATABASE_URL) {
  process.env.DATABASE_URL = envLocal.parsed.DATABASE_URL;
}
if (!process.env.NEON_AUTH_URL && envLocal.parsed?.NEON_AUTH_URL) {
  process.env.NEON_AUTH_URL = envLocal.parsed.NEON_AUTH_URL;
}
if (!process.env.NEON_JWKS_URL && envLocal.parsed?.NEON_JWKS_URL) {
  process.env.NEON_JWKS_URL = envLocal.parsed.NEON_JWKS_URL;
}

declare global {
  var _neonPostgresPool: Pool | undefined;
  var _schemaInitialized: boolean | undefined;
}

export const getPool = (): Pool => {
  if (!global._neonPostgresPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    }
    global._neonPostgresPool = new Pool({
      connectionString,
      ssl: connectionString?.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });

    global._neonPostgresPool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL pool client:', err);
    });
  }
  return global._neonPostgresPool;
};

export const pool = getPool();
export const db = drizzle(pool, { schema });

export async function ensureSchemaInitialized(): Promise<void> {
  if (global._schemaInitialized) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not configured.');
  }

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      -- Clean up any legacy custom auth tables so Neon Auth (neon_auth."user") is the sole source of truth
      DROP TABLE IF EXISTS public.password_reset_tokens CASCADE;
      DROP TABLE IF EXISTS public.sessions CASCADE;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'profiles' AND constraint_name = 'profiles_id_fkey'
        ) THEN
          ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'test_results' AND constraint_name = 'test_results_user_id_fkey'
        ) THEN
          ALTER TABLE public.test_results DROP CONSTRAINT test_results_user_id_fkey;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'posts' AND constraint_name = 'posts_user_id_fkey'
        ) THEN
          ALTER TABLE public.posts DROP CONSTRAINT posts_user_id_fkey;
        END IF;
      END $$;

      DROP TABLE IF EXISTS public.users CASCADE;

      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
        username TEXT,
        avatar_url TEXT,
        score INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.test_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        score INTEGER NOT NULL,
        total_questions INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'profiles' AND constraint_type = 'FOREIGN KEY'
        ) THEN
          DELETE FROM public.profiles WHERE id NOT IN (SELECT id FROM neon_auth."user");
          ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_id_neon_auth_fkey
            FOREIGN KEY (id) REFERENCES neon_auth."user"(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'test_results' AND constraint_type = 'FOREIGN KEY'
        ) THEN
          DELETE FROM public.test_results WHERE user_id NOT IN (SELECT id FROM neon_auth."user");
          ALTER TABLE public.test_results
            ADD CONSTRAINT test_results_user_id_neon_auth_fkey
            FOREIGN KEY (user_id) REFERENCES neon_auth."user"(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'posts' AND constraint_type = 'FOREIGN KEY'
        ) THEN
          DELETE FROM public.posts WHERE user_id NOT IN (SELECT id FROM neon_auth."user");
          ALTER TABLE public.posts
            ADD CONSTRAINT posts_user_id_neon_auth_fkey
            FOREIGN KEY (user_id) REFERENCES neon_auth."user"(id) ON DELETE CASCADE;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_profiles_score ON public.profiles(score DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_created_at ON public.posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_user_id ON public.posts(user_id);
      CREATE INDEX IF NOT EXISTS idx_test_results_user_created ON public.test_results(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS public.gemini_question_pool (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind TEXT NOT NULL,
        topic TEXT NOT NULL,
        difficulty TEXT NOT NULL DEFAULT 'Medium',
        question_text TEXT NOT NULL,
        question_data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (kind, topic, difficulty, question_text)
      );

      CREATE INDEX IF NOT EXISTS idx_gemini_question_pool_lookup
        ON public.gemini_question_pool(kind, topic, difficulty);
    `);
    global._schemaInitialized = true;
  } finally {
    client.release();
  }
}
