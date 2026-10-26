import type { Config, Context } from "@netlify/functions";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, sessions, threads, posts, profileComments } from "../../db/schema.js";

type User = typeof users.$inferSelect;

const COOKIE = "citylive.sid";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const REACTIONS = ["🤩", "😂", "👍", "😡", "😭"];

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

function roleName(level: number) {
  if (level >= 100) return "Главный администратор";
  if (level >= 50) return "Администратор";
  if (level >= 20) return "Модератор";
  return "Игрок";
}
function safeUser(u: User | null) {
  if (!u) return null;
  const { passwordHash, ...out } = u;
  return { ...out, roleName: roleName(out.level) };
}
function validNick(nick: string) { return /^[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(nick) && nick.length <= 24; }
function cleanText(v: unknown, max = 2000) { return String(v ?? "").trim().slice(0, max); }
function validColor(c: unknown) { return /^#[0-9a-fA-F]{6}$/.test(String(c || "")); }

async function findUser(nick: string) {
  const [u] = await db.select().from(users).where(sql`lower(${users.nick}) = lower(${nick})`);
  return u || null;
}

// Creates the owner account from ADMIN_USER / ADMIN_PASSWORD when the forum has no users yet.
async function ensureOwner() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return;
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  if (count > 0) return;
  await db.insert(users).values({
    nick: process.env.ADMIN_USER || "Amir_Yaguar", passwordHash: await bcrypt.hash(password, 10),
    level: 100, title: "Главный администратор", titleColor: "#e74c3c",
    signature: "CityLive RP", bio: "Главный администратор форума",
  }).onConflictDoNothing();
}

async function currentUser(context: Context) {
  const token = context.cookies.get(COOKIE);
  if (!token) return null;
  const [row] = await db.select({ user: users }).from(sessions)
    .innerJoin(users, eq(sessions.nick, users.nick))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())));
  return row?.user || null;
}

async function startSession(context: Context, nick: string) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({ token, nick, expiresAt: new Date(Date.now() + SESSION_MS) });
  context.cookies.set({ name: COOKIE, value: token, path: "/", httpOnly: true, secure: true, sameSite: "Lax", expires: new Date(Date.now() + SESSION_MS) });
}

async function endSession(context: Context) {
  const token = context.cookies.get(COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.token, token));
  context.cookies.delete({ name: COOKIE, path: "/" });
}

async function handle(req: Request, context: Context) {
  const path = new URL(req.url).pathname.replace(/^\/api/, "").replace(/\/+$/, "");
  const method = req.method;
  const body: any = method === "GET" ? {} : await req.json().catch(() => ({}));
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

  await ensureOwner();
  const me = await currentUser(context);
  const auth = () => me || fail(401, "Сначала войдите в аккаунт.");
  const mod = () => (me && me.level >= 20 ? me : fail(403, "Недостаточно прав."));

  if (method === "GET" && path === "/state") {
    const [allUsers, allThreads, allPosts, comments] = await Promise.all([
      db.select().from(users).orderBy(asc(users.createdAt)),
      db.select().from(threads).orderBy(desc(threads.id)),
      db.select().from(posts).orderBy(asc(posts.id)),
      db.select().from(profileComments).orderBy(asc(profileComments.id)),
    ]);
    return {
      me: safeUser(me),
      users: allUsers.map(safeUser),
      threads: allThreads.map(t => ({ ...t, posts: allPosts.filter(p => p.threadId === t.id).map(({ threadId, ...p }) => p) })),
      profileComments: comments,
    };
  }

  if (method === "POST" && path === "/register") {
    const nick = cleanText(body.nick, 24);
    const password = String(body.password || "");
    if (!validNick(nick)) fail(400, "Ник должен быть в формате Example_Ivanov: латинские буквы/цифры, одно подчёркивание.");
    if (password.length < 10) fail(400, "Пароль должен содержать минимум 10 символов.");
    if (await findUser(nick)) fail(409, "Такой ник уже занят. Выберите другой.");
    const [user] = await db.insert(users).values({ nick, passwordHash: await bcrypt.hash(password, 10) }).returning();
    await startSession(context, nick);
    return { me: safeUser(user) };
  }

  if (method === "POST" && path === "/login") {
    const user = await findUser(cleanText(body.nick, 24));
    if (!user || !(await bcrypt.compare(String(body.password || ""), user.passwordHash || ""))) fail(401, "Неверный ник или пароль.");
    await startSession(context, user!.nick);
    return { me: safeUser(user) };
  }

  if (method === "POST" && path === "/logout") {
    await endSession(context);
    return { ok: true };
  }

  if (method === "DELETE" && path === "/account") {
    const u = auth();
    if (u.level >= 100) {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(sql`${users.level} >= 100`);
      if (count <= 1) fail(400, "Нельзя удалить единственный аккаунт главного администратора. Сначала назначьте другого главного администратора.");
    }
    await db.delete(users).where(eq(users.nick, u.nick));
    context.cookies.delete({ name: COOKIE, path: "/" });
    return { ok: true };
  }

  if (method === "PATCH" && path === "/profile") {
    const u = auth();
    const avatar = cleanText(body.avatar, 500);
    if (avatar && !/^https?:\/\/\S+$/i.test(avatar)) fail(400, "Аватарка должна быть ссылкой http:// или https://.");
    const [updated] = await db.update(users)
      .set({ avatar, bio: cleanText(body.bio, 500), signature: cleanText(body.signature, 200) })
      .where(eq(users.nick, u.nick)).returning();
    return { me: safeUser(updated) };
  }

  if (method === "POST" && parts[0] === "profile" && parts[2] === "comments" && parts.length === 3) {
    const u = auth();
    const target = await findUser(parts[1]) || fail(404, "Профиль не найден.");
    const text = cleanText(body.text, 500);
    if (!text) fail(400, "Напишите комментарий.");
    await db.insert(profileComments).values({ target: target.nick, author: u.nick, text });
    return { ok: true };
  }

  if (method === "POST" && path === "/threads") {
    const u = auth();
    const title = cleanText(body.title, 120), text = cleanText(body.body, 4000);
    if (!title || !text) fail(400, "Заполните заголовок и сообщение.");
    const [t] = await db.insert(threads).values({ title, author: u.nick }).returning();
    const [p] = await db.insert(posts).values({ threadId: t.id, id: 1, author: u.nick, body: text }).returning();
    return { thread: { ...t, posts: [p] } };
  }

  if (parts[0] === "threads" && parts.length >= 3) {
    const threadId = Number(parts[1]);
    const getThread = async () => {
      const [t] = Number.isInteger(threadId) ? await db.select().from(threads).where(eq(threads.id, threadId)) : [];
      return t || null;
    };

    if (method === "POST" && parts[2] === "replies" && parts.length === 3) {
      const u = auth();
      const t = await getThread() || fail(404, "Тема не найдена.");
      if (t.closed) fail(423, "Тема закрыта администрацией.");
      const text = cleanText(body.body, 4000);
      if (!text) fail(400, "Введите текст ответа.");
      const replyTo = Number(body.replyTo) || null;
      if (replyTo) {
        const [target] = await db.select().from(posts).where(and(eq(posts.threadId, t.id), eq(posts.id, replyTo)));
        if (!target) fail(400, "Сообщение, на которое отвечаете, не найдено.");
      }
      const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${posts.id}), 0)::int + 1` }).from(posts).where(eq(posts.threadId, t.id));
      await db.insert(posts).values({ threadId: t.id, id: next, author: u.nick, body: text, replyTo });
      return { ok: true };
    }

    if (method === "POST" && parts[2] === "posts" && parts[4] === "reactions" && parts.length === 5) {
      const u = auth();
      const emoji = body.emoji;
      if (!REACTIONS.includes(emoji)) fail(400, "Недопустимая реакция.");
      const postId = Number(parts[3]);
      const [p] = Number.isInteger(threadId) && Number.isInteger(postId)
        ? await db.select().from(posts).where(and(eq(posts.threadId, threadId), eq(posts.id, postId)))
        : [];
      if (!p) fail(404, "Сообщение не найдено.");
      const reactions = { ...(p.reactions || {}) };
      const list = reactions[emoji] || [];
      reactions[emoji] = list.includes(u.nick) ? list.filter(n => n !== u.nick) : [...list, u.nick];
      await db.update(posts).set({ reactions }).where(and(eq(posts.threadId, threadId), eq(posts.id, postId)));
      return { ok: true };
    }

    if (method === "PATCH" && parts[2] === "close" && parts.length === 3) {
      mod();
      const t = await getThread() || fail(404, "Тема не найдена.");
      await db.update(threads).set({ closed: Boolean(body.closed) }).where(eq(threads.id, t.id));
      return { ok: true };
    }
  }

  if (method === "PATCH" && parts[0] === "users" && parts.length === 3) {
    const m = mod();
    if (parts[2] === "permissions") {
      const target = await findUser(parts[1]) || fail(404, "Пользователь с таким ником не найден. Сначала он должен зарегистрироваться.");
      const requested = Number(body.level);
      if (![0, 20, 50, 100].includes(requested)) fail(400, "Неизвестный уровень прав.");
      if (requested > m.level) fail(403, "Нельзя выдать больше прав, чем есть у вас.");
      if (target.level >= m.level && target.nick !== m.nick) fail(403, "Нельзя менять права сотрудника с равным или более высоким уровнем.");
      const [updated] = await db.update(users).set({ level: requested }).where(eq(users.nick, target.nick)).returning();
      return { user: safeUser(updated) };
    }
    if (parts[2] === "title") {
      const target = await findUser(parts[1]) || fail(404, "Пользователь не найден.");
      if (target.level >= m.level && target.nick !== m.nick) fail(403, "Нельзя менять титул сотрудника с равным или более высоким уровнем.");
      const title = cleanText(body.title, 40), color = String(body.color || "");
      if (!validColor(color)) fail(400, "Выберите корректный цвет.");
      const [updated] = await db.update(users).set({ title, titleColor: color }).where(eq(users.nick, target.nick)).returning();
      return { user: safeUser(updated) };
    }
  }

  fail(404, "Неизвестный запрос.");
}

export default async (req: Request, context: Context) => {
  try {
    return Response.json(await handle(req, context));
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
    console.error(e);
    return Response.json({ error: "Ошибка сервера. Попробуйте позже." }, { status: 500 });
  }
};

export const config: Config = {
  path: "/api/*",
};
