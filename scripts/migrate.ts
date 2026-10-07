import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { pool, ensureSchemaInitialized } from '../src/db/index';

async function runMigration() {
  console.log('Running Neon PostgreSQL + Neon Auth schema migration...');
  const client = await pool.connect();
  try {
    // Remove obsolete custom auth tables if empty, and point public tables to neon_auth."user"(id)
    await client.query(`
      DROP TABLE IF EXISTS public.password_reset_tokens CASCADE;
      DROP TABLE IF EXISTS public.sessions CASCADE;

      -- Update foreign keys on profiles, test_results, and posts to reference neon_auth."user"(id)
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
    `);

    await ensureSchemaInitialized();

    // Ensure foreign keys to neon_auth."user"(id) exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'profiles' AND constraint_name = 'profiles_id_neon_auth_fkey'
        ) THEN
          ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_id_neon_auth_fkey
            FOREIGN KEY (id) REFERENCES neon_auth."user"(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'test_results' AND constraint_name = 'test_results_user_id_neon_auth_fkey'
        ) THEN
          ALTER TABLE public.test_results
            ADD CONSTRAINT test_results_user_id_neon_auth_fkey
            FOREIGN KEY (user_id) REFERENCES neon_auth."user"(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = 'posts' AND constraint_name = 'posts_user_id_neon_auth_fkey'
        ) THEN
          ALTER TABLE public.posts
            ADD CONSTRAINT posts_user_id_neon_auth_fkey
            FOREIGN KEY (user_id) REFERENCES neon_auth."user"(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    // Sync any existing users in neon_auth."user" into public.profiles
    await client.query(`
      INSERT INTO public.profiles (id, username, avatar_url, score)
      SELECT id, COALESCE(name, split_part(email, '@', 1)), image, 0
      FROM neon_auth."user"
      ON CONFLICT (id) DO NOTHING;
    `);

    const tables = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('public', 'neon_auth')
      ORDER BY table_schema, table_name;
    `);
    console.log('Verified Neon tables:', tables.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
