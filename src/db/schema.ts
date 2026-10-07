import { relations } from 'drizzle-orm';
import {
  pgTable,
  pgSchema,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';

// Existing Neon Auth schema managed by Neon Auth service
export const neonAuthSchema = pgSchema('neon_auth');

export const neonUsers = neonAuthSchema.table('user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  role: text('role'),
  banned: boolean('banned'),
  banReason: text('banReason'),
  banExpires: timestamp('banExpires', { withTimezone: true }),
});

export const neonSessions = neonAuthSchema.table('session', {
  id: uuid('id').primaryKey(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: uuid('userId')
    .notNull()
    .references(() => neonUsers.id, { onDelete: 'cascade' }),
  impersonatedBy: text('impersonatedBy'),
  activeOrganizationId: text('activeOrganizationId'),
});

export const neonVerifications = neonAuthSchema.table('verification', {
  id: uuid('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
});

// Application tables in public schema referencing neon_auth.user(id)
export const profiles = pgTable('profiles', {
  id: uuid('id')
    .primaryKey()
    .references(() => neonUsers.id, { onDelete: 'cascade' }),
  username: text('username'),
  avatarUrl: text('avatar_url'),
  score: integer('score').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const testResults = pgTable('test_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => neonUsers.id, { onDelete: 'cascade' }),
  topic: text('topic').notNull(),
  score: integer('score').notNull(),
  totalQuestions: integer('total_questions').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const posts = pgTable('posts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => neonUsers.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const geminiQuestionPool = pgTable('gemini_question_pool', {
  id: uuid('id').defaultRandom().primaryKey(),
  kind: text('kind').notNull(), // 'practice' | 'voice'
  topic: text('topic').notNull(),
  difficulty: text('difficulty').notNull().default('Medium'),
  questionText: text('question_text').notNull(),
  questionData: jsonb('question_data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Relations
export const neonUsersRelations = relations(neonUsers, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [neonUsers.id],
    references: [profiles.id],
  }),
  sessions: many(neonSessions),
  testResults: many(testResults),
  posts: many(posts),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  user: one(neonUsers, {
    fields: [profiles.id],
    references: [neonUsers.id],
  }),
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  authorProfile: one(profiles, {
    fields: [posts.userId],
    references: [profiles.id],
  }),
  authorUser: one(neonUsers, {
    fields: [posts.userId],
    references: [neonUsers.id],
  }),
}));

export const testResultsRelations = relations(testResults, ({ one }) => ({
  user: one(neonUsers, {
    fields: [testResults.userId],
    references: [neonUsers.id],
  }),
}));
