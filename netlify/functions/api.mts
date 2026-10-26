import type { Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const COOKIE = "citylive.sid";
const SESSION_DAYS = 7;
const REACTIONS = ["🤩", "😂", "👍", "😡", "😭"];

type User = {
  nick: string; password_hash: string; level: number; title: string; title_color: string;
  avatar: string; signature: string; bio: string; created_at: string;
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function roleName(level: number) {
  if (level >= 100) return "Главный администратор";
  if (level >= 50) return "Администратор";
  if (level >= 20) return "Модератор";
  return "Игрок";
}
function safeUser(u: User | null) {
  if (!u) return null;
  return {
    nick: u.nick, level: u.level, title: u.title, titleColor: u.title_color, avatar: u.avatar,
    signature: u.signature, bio: u.bio, createdAt: u.created_at, roleName: roleName(u.level),
  };
}
function validNick(nick: string) { return /^[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(nick) && nick.length <= 24; }
function cleanText(v: unknown, max = 2000) { return String(v ?? "").trim().slice(0, max); }
function validColor(c: unknown) { return /^#[0-9a-fA-F]{6}$/.test(String(c || "")); }

function getCookie(req: Request, name: string) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function sessionCookie(token: string, maxAge: number) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export default async (req: Request) => {
  const db = getDatabase();
  const sql = db.sql;
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = req.method;
  const headers = new Headers();

  const json = (data: unknown, status = 200) => {
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(data), { status, headers });
  };

  const body = async (): Promise<Record<string, any>> => {
    try { return (await req.json()) || {}; } catch { return {}; }
  };

  const findUser = async (nick: string): Promise<User | null> => {
    const [u] = await sql`SELECT * FROM users WHERE LOWER(nick) = LOWER(${nick})`;
    return (u as User) || null;
  };

  const current = async (): Promise<User | null> => {
    const token = getCookie(req, COOKIE);
    if (!token) return null;
    const [u] = await sql`
      SELECT u.* FROM sessions s JOIN users u ON u.nick = s.nick
      WHERE s.token = ${token} AND s.expires_at > NOW()`;
    return (u as User) || null;
  };
  const auth = async () => {
    const u = await current();
    if (!u) throw new HttpError(401, "Сначала войдите в аккаунт.");
    return u;
  };
  const mod = async () => {
    const u = await current();
    if (!u || u.level < 20) throw new HttpError(403, "Недостаточно прав.");
    return u;
  };
  const startSession = async (nick: string) => {
    const token = randomBytes(32).toString("hex");
    await sql`INSERT INTO sessions (token, nick, expires_at)
      VALUES (${token}, ${nick}, NOW() + make_interval(days => ${SESSION_DAYS}))`;
    await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
    headers.append("Set-Cookie", sessionCookie(token, SESSION_DAYS * 24 * 60 * 60));
  };
  const endSession = async () => {
    const token = getCookie(req, COOKIE);
    if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
    headers.append("Set-Cookie", sessionCookie("", 0));
  };

  // Первый главный администратор: если ни одного ещё нет, ник владельца получает уровень 100.
  const ensureOwner = async () => {
    const ownerNick = process.env.ADMIN_USER || "Amir_Yaguar";
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE level >= 100`;
    if (count > 0) return;
    const owner = await findUser(ownerNick);
    if (owner) {
      await sql`UPDATE users SET level = 100, title = 'Главный администратор', title_color = '#e74c3c'
        WHERE nick = ${owner.nick}`;
    } else if (process.env.ADMIN_PASSWORD) {
      await sql`INSERT INTO users (nick, password_hash, level, title, title_color, signature, bio)
        VALUES (${ownerNick}, ${await bcrypt.hash(process.env.ADMIN_PASSWORD, 10)}, 100,
          'Главный администратор', '#e74c3c', 'CityLive RP', 'Главный администратор форума')`;
    }
  };

  try {
    let m: RegExpMatchArray | null;

    if (method === "GET" && route === "/state") {
      const me = await current();
      const users = (await sql`SELECT * FROM users ORDER BY created_at`) as User[];
      const threads = await sql`SELECT * FROM threads ORDER BY id DESC`;
      const posts = await sql`SELECT * FROM posts ORDER BY thread_id, id`;
      const comments = await sql`SELECT * FROM profile_comments ORDER BY id`;
      return json({
        me: safeUser(me),
        users: users.map(safeUser),
        threads: threads.map((t: any) => ({
          id: t.id, title: t.title, author: t.author, closed: t.closed, createdAt: t.created_at,
          posts: posts.filter((p: any) => p.thread_id === t.id).map((p: any) => ({
            id: p.id, author: p.author, body: p.body, replyTo: p.reply_to, reactions: p.reactions || {}, createdAt: p.created_at,
          })),
        })),
        profileComments: comments.map((c: any) => ({
          id: Number(c.id), target: c.target, author: c.author, text: c.text, createdAt: c.created_at,
        })),
      });
    }

    if (method === "POST" && route === "/register") {
      const b = await body();
      const nick = cleanText(b.nick, 24);
      const password = String(b.password || "");
      if (!validNick(nick)) throw new HttpError(400, "Ник должен быть в формате Example_Ivanov: латинские буквы/цифры, одно подчёркивание.");
      if (password.length < 10) throw new HttpError(400, "Пароль должен содержать минимум 10 символов.");
      if (await findUser(nick)) throw new HttpError(409, "Такой ник уже занят. Выберите другой.");
      try {
        await sql`INSERT INTO users (nick, password_hash) VALUES (${nick}, ${await bcrypt.hash(password, 10)})`;
      } catch {
        throw new HttpError(409, "Такой ник уже занят. Выберите другой.");
      }
      await ensureOwner();
      await startSession(nick);
      return json({ me: safeUser(await findUser(nick)) });
    }

    if (method === "POST" && route === "/login") {
      const b = await body();
      await ensureOwner();
      const user = await findUser(cleanText(b.nick, 24));
      if (!user || !(await bcrypt.compare(String(b.password || ""), user.password_hash || ""))) {
        throw new HttpError(401, "Неверный ник или пароль.");
      }
      await startSession(user.nick);
      return json({ me: safeUser(await findUser(user.nick)) });
    }

    if (method === "POST" && route === "/logout") {
      await endSession();
      return json({ ok: true });
    }

    if (method === "DELETE" && route === "/account") {
      const me = await auth();
      if (me.level >= 100) {
        const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE level >= 100`;
        if (count <= 1) throw new HttpError(400, "Нельзя удалить единственный аккаунт главного администратора. Сначала назначьте другого главного администратора.");
      }
      await sql`DELETE FROM profile_comments WHERE author = ${me.nick} OR target = ${me.nick}`;
      await sql`DELETE FROM users WHERE nick = ${me.nick}`;
      headers.append("Set-Cookie", sessionCookie("", 0));
      return json({ ok: true });
    }

    if (method === "PATCH" && route === "/profile") {
      const me = await auth();
      const b = await body();
      const avatar = cleanText(b.avatar, 500);
      if (avatar && !/^https?:\/\/\S+$/i.test(avatar)) throw new HttpError(400, "Аватарка должна быть ссылкой http:// или https://.");
      await sql`UPDATE users SET avatar = ${avatar}, bio = ${cleanText(b.bio, 500)},
        signature = ${cleanText(b.signature, 200)} WHERE nick = ${me.nick}`;
      return json({ me: safeUser(await findUser(me.nick)) });
    }

    if (method === "POST" && (m = route.match(/^\/profile\/([^/]+)\/comments$/))) {
      const me = await auth();
      const target = await findUser(decodeURIComponent(m[1]));
      if (!target) throw new HttpError(404, "Профиль не найден.");
      const text = cleanText((await body()).text, 500);
      if (!text) throw new HttpError(400, "Напишите комментарий.");
      await sql`INSERT INTO profile_comments (target, author, text) VALUES (${target.nick}, ${me.nick}, ${text})`;
      return json({ ok: true });
    }

    if (method === "POST" && route === "/threads") {
      const me = await auth();
      const b = await body();
      const title = cleanText(b.title, 120), text = cleanText(b.body, 4000);
      if (!title || !text) throw new HttpError(400, "Заполните заголовок и сообщение.");
      const [t] = await sql`INSERT INTO threads (title, author) VALUES (${title}, ${me.nick}) RETURNING *`;
      await sql`INSERT INTO posts (thread_id, id, author, body) VALUES (${t.id}, 1, ${me.nick}, ${text})`;
      return json({ thread: { id: t.id, title: t.title, author: t.author, closed: t.closed, createdAt: t.created_at } });
    }

    if (method === "POST" && (m = route.match(/^\/threads\/(\d+)\/replies$/))) {
      const me = await auth();
      const threadId = Number(m[1]);
      const [t] = await sql`SELECT * FROM threads WHERE id = ${threadId}`;
      if (!t) throw new HttpError(404, "Тема не найдена.");
      if (t.closed) throw new HttpError(423, "Тема закрыта администрацией.");
      const b = await body();
      const text = cleanText(b.body, 4000);
      if (!text) throw new HttpError(400, "Введите текст ответа.");
      const replyTo = Number(b.replyTo) || null;
      if (replyTo) {
        const [p] = await sql`SELECT 1 FROM posts WHERE thread_id = ${threadId} AND id = ${replyTo}`;
        if (!p) throw new HttpError(400, "Сообщение, на которое отвечаете, не найдено.");
      }
      await sql`INSERT INTO posts (thread_id, id, author, body, reply_to)
        SELECT ${threadId}, COALESCE(MAX(id), 0) + 1, ${me.nick}, ${text}, ${replyTo}
        FROM posts WHERE thread_id = ${threadId}`;
      return json({ ok: true });
    }

    if (method === "POST" && (m = route.match(/^\/threads\/(\d+)\/posts\/(\d+)\/reactions$/))) {
      const me = await auth();
      const emoji = (await body()).emoji;
      if (!REACTIONS.includes(emoji)) throw new HttpError(400, "Недопустимая реакция.");
      const [p] = await sql`SELECT reactions FROM posts WHERE thread_id = ${Number(m[1])} AND id = ${Number(m[2])}`;
      if (!p) throw new HttpError(404, "Сообщение не найдено.");
      const reactions: Record<string, string[]> = p.reactions || {};
      const list = reactions[emoji] || [];
      reactions[emoji] = list.includes(me.nick) ? list.filter(n => n !== me.nick) : [...list, me.nick];
      await sql`UPDATE posts SET reactions = ${JSON.stringify(reactions)}::jsonb
        WHERE thread_id = ${Number(m[1])} AND id = ${Number(m[2])}`;
      return json({ ok: true });
    }

    if (method === "PATCH" && (m = route.match(/^\/threads\/(\d+)\/close$/))) {
      await mod();
      const closed = Boolean((await body()).closed);
      const rows = await sql`UPDATE threads SET closed = ${closed} WHERE id = ${Number(m[1])} RETURNING id`;
      if (!rows.length) throw new HttpError(404, "Тема не найдена.");
      return json({ ok: true });
    }

    if (method === "PATCH" && (m = route.match(/^\/users\/([^/]+)\/permissions$/))) {
      const me = await mod();
      const target = await findUser(decodeURIComponent(m[1]));
      if (!target) throw new HttpError(404, "Пользователь с таким ником не найден. Сначала он должен зарегистрироваться.");
      const requested = Number((await body()).level);
      if (![0, 20, 50, 100].includes(requested)) throw new HttpError(400, "Неизвестный уровень прав.");
      if (requested > me.level) throw new HttpError(403, "Нельзя выдать больше прав, чем есть у вас.");
      if (target.level >= me.level && target.nick !== me.nick) throw new HttpError(403, "Нельзя менять права сотрудника с равным или более высоким уровнем.");
      await sql`UPDATE users SET level = ${requested} WHERE nick = ${target.nick}`;
      return json({ user: safeUser(await findUser(target.nick)) });
    }

    if (method === "PATCH" && (m = route.match(/^\/users\/([^/]+)\/title$/))) {
      const me = await mod();
      const target = await findUser(decodeURIComponent(m[1]));
      if (!target) throw new HttpError(404, "Пользователь не найден.");
      if (target.level >= me.level && target.nick !== me.nick) throw new HttpError(403, "Нельзя менять титул сотрудника с равным или более высоким уровнем.");
      const b = await body();
      if (!validColor(b.color)) throw new HttpError(400, "Выберите корректный цвет.");
      await sql`UPDATE users SET title = ${cleanText(b.title, 40)}, title_color = ${String(b.color)} WHERE nick = ${target.nick}`;
      return json({ user: safeUser(await findUser(target.nick)) });
    }

    return json({ error: "Не найдено." }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Ошибка сервера. Попробуйте ещё раз." }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
