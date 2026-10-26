import { pgTable, serial, text, timestamp, integer, boolean, jsonb, primaryKey } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  nick: text().primaryKey(),
  passwordHash: text("password_hash").notNull(),
  level: integer().notNull().default(0),
  title: text().notNull().default(""),
  titleColor: text("title_color").notNull().default("#ffffff"),
  avatar: text().notNull().default(""),
  signature: text().notNull().default(""),
  bio: text().notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  token: text().primaryKey(),
  nick: text().notNull().references(() => users.nick, { onDelete: "cascade", onUpdate: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const threads = pgTable("threads", {
  id: serial().primaryKey(),
  title: text().notNull(),
  author: text().notNull(),
  closed: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const posts = pgTable("posts", {
  threadId: integer("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  id: integer().notNull(),
  author: text().notNull(),
  body: text().notNull(),
  replyTo: integer("reply_to"),
  reactions: jsonb().$type<Record<string, string[]>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.threadId, t.id] })]);

export const profileComments = pgTable("profile_comments", {
  id: serial().primaryKey(),
  target: text().notNull().references(() => users.nick, { onDelete: "cascade", onUpdate: "cascade" }),
  author: text().notNull().references(() => users.nick, { onDelete: "cascade", onUpdate: "cascade" }),
  text: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
