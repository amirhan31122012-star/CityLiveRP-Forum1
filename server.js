const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

function read(name, fallback) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function write(name, value) {
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(value, null, 2));
}
let users = read("users.json", []);
let threads = read("threads.json", []);
let profileComments = read("profile-comments.json", []);
let nextThreadId = () => Math.max(0, ...threads.map(t => t.id || 0)) + 1;

const OWNER_NICK = process.env.ADMIN_USER || "Amir_Yaguar";
const OWNER_PASSWORD = process.env.ADMIN_PASSWORD;
if (!users.length && OWNER_PASSWORD) {
  users.push({
    nick: OWNER_NICK, passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 10),
    level: 100, title: "Главный администратор", titleColor: "#e74c3c",
    avatar: "", signature: "CityLive RP", bio: "Главный администратор форума",
    createdAt: new Date().toISOString()
  });
  write("users.json", users);
}
if (!users.length && !OWNER_PASSWORD) {
  console.warn("ВНИМАНИЕ: пользователей пока нет. Задайте ADMIN_USER и ADMIN_PASSWORD при первом запуске.");
}

app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "citylive.sid",
  secret: process.env.SESSION_SECRET || "CHANGE_THIS_SESSION_SECRET_BEFORE_PUBLIC_HOSTING",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const levels = { "Игрок": 0, "Модератор": 20, "Администратор": 50, "Главный администратор": 100 };
function current(req) { return users.find(u => u.nick === req.session.nick) || null; }
function safeUser(u) {
  if (!u) return null;
  const { passwordHash, ...out } = u;
  out.roleName = roleName(out.level);
  return out;
}
function roleName(level) {
  if (level >= 100) return "Главный администратор";
  if (level >= 50) return "Администратор";
  if (level >= 20) return "Модератор";
  return "Игрок";
}
function auth(req, res, next) {
  if (!current(req)) return res.status(401).json({ error: "Сначала войдите в аккаунт." });
  next();
}
function mod(req, res, next) {
  const u = current(req);
  if (!u || u.level < 20) return res.status(403).json({ error: "Недостаточно прав." });
  next();
}
function validNick(nick) { return typeof nick === "string" && /^[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(nick) && nick.length <= 24; }
function cleanText(v, max = 2000) { return String(v ?? "").trim().slice(0, max); }
function validColor(c) { return /^#[0-9a-fA-F]{6}$/.test(String(c || "")); }

app.get("/api/state", (req, res) => {
  res.json({
    me: safeUser(current(req)),
    users: users.map(safeUser),
    threads: threads.map(t => ({ ...t, posts: t.posts || [] })),
    profileComments
  });
});

app.post("/api/register", async (req, res) => {
  const nick = cleanText(req.body.nick, 24);
  const password = String(req.body.password || "");
  if (!validNick(nick)) return res.status(400).json({ error: "Ник должен быть в формате Example_Ivanov: латинские буквы/цифры, одно подчёркивание." });
  if (password.length < 10) return res.status(400).json({ error: "Пароль должен содержать минимум 10 символов." });
  if (users.some(u => String(u.nick).toLowerCase() === nick.toLowerCase())) return res.status(409).json({ error: "Такой ник уже занят. Выберите другой." });
  const user = { nick, passwordHash: await bcrypt.hash(password, 10), level: 0, title: "", titleColor: "#ffffff", avatar: "", signature: "", bio: "", createdAt: new Date().toISOString() };
  users.push(user); write("users.json", users);
  req.session.nick = nick;
  res.json({ me: safeUser(user) });
});
app.post("/api/login", async (req, res) => {
  const nick = cleanText(req.body.nick, 24);
  const user = users.find(u => u.nick.toLowerCase() === nick.toLowerCase());
  if (!user || !await bcrypt.compare(String(req.body.password || ""), user.passwordHash || "")) return res.status(401).json({ error: "Неверный ник или пароль." });
  req.session.nick = user.nick;
  res.json({ me: safeUser(user) });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.delete("/api/account", auth, (req, res) => {
  const me = current(req);
  if (me.level >= 100 && users.filter(u => u.level >= 100).length <= 1) {
    return res.status(400).json({ error: "Нельзя удалить единственный аккаунт главного администратора. Сначала назначьте другого главного администратора." });
  }
  users = users.filter(u => u.nick !== me.nick);
  profileComments = profileComments.filter(c => c.author !== me.nick && c.target !== me.nick);
  write("users.json", users);
  write("profile-comments.json", profileComments);
  req.session.destroy(() => res.json({ ok: true }));
});

app.patch("/api/profile", auth, (req, res) => {
  const me = current(req);
  const avatar = cleanText(req.body.avatar, 500);
  if (avatar && !/^https?:\/\/\S+$/i.test(avatar)) return res.status(400).json({ error: "Аватарка должна быть ссылкой http:// или https://." });
  me.avatar = avatar;
  me.bio = cleanText(req.body.bio, 500);
  me.signature = cleanText(req.body.signature, 200);
  write("users.json", users);
  res.json({ me: safeUser(me) });
});
app.post("/api/profile/:nick/comments", auth, (req, res) => {
  const target = users.find(u => u.nick.toLowerCase() === req.params.nick.toLowerCase());
  if (!target) return res.status(404).json({ error: "Профиль не найден." });
  const text = cleanText(req.body.text, 500);
  if (!text) return res.status(400).json({ error: "Напишите комментарий." });
  profileComments.push({ id: Date.now(), target: target.nick, author: current(req).nick, text, createdAt: new Date().toISOString() });
  write("profile-comments.json", profileComments);
  res.json({ ok: true });
});

app.post("/api/threads", auth, (req, res) => {
  const title = cleanText(req.body.title, 120), body = cleanText(req.body.body, 4000);
  if (!title || !body) return res.status(400).json({ error: "Заполните заголовок и сообщение." });
  const t = { id: nextThreadId(), title, author: current(req).nick, createdAt: new Date().toISOString(), closed: false, posts: [{ id: 1, author: current(req).nick, body, createdAt: new Date().toISOString(), reactions: {} }] };
  threads.unshift(t); write("threads.json", threads); res.json({ thread: t });
});
app.post("/api/threads/:id/replies", auth, (req, res) => {
  const t = threads.find(x => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: "Тема не найдена." });
  if (t.closed) return res.status(423).json({ error: "Тема закрыта администрацией." });
  const body = cleanText(req.body.body, 4000);
  if (!body) return res.status(400).json({ error: "Введите текст ответа." });
  const replyTo = Number(req.body.replyTo) || null;
  if (replyTo && !t.posts.some(p => p.id === replyTo)) return res.status(400).json({ error: "Сообщение, на которое отвечаете, не найдено." });
  const id = Math.max(0, ...t.posts.map(p => p.id)) + 1;
  t.posts.push({ id, author: current(req).nick, body, replyTo, createdAt: new Date().toISOString(), reactions: {} });
  write("threads.json", threads); res.json({ ok: true });
});
app.post("/api/threads/:id/posts/:postId/reactions", auth, (req, res) => {
  const allowed = ["🤩", "😂", "👍", "😡", "😭"];
  const emoji = req.body.emoji;
  if (!allowed.includes(emoji)) return res.status(400).json({ error: "Недопустимая реакция." });
  const t = threads.find(x => x.id === Number(req.params.id));
  const p = t && t.posts.find(x => x.id === Number(req.params.postId));
  if (!p) return res.status(404).json({ error: "Сообщение не найдено." });
  p.reactions ||= {};
  p.reactions[emoji] ||= [];
  const nick = current(req).nick;
  p.reactions[emoji] = p.reactions[emoji].includes(nick) ? p.reactions[emoji].filter(n => n !== nick) : [...p.reactions[emoji], nick];
  write("threads.json", threads); res.json({ ok: true });
});
app.patch("/api/threads/:id/close", mod, (req, res) => {
  const t = threads.find(x => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: "Тема не найдена." });
  t.closed = Boolean(req.body.closed);
  write("threads.json", threads); res.json({ ok: true });
});
app.patch("/api/users/:nick/permissions", mod, (req, res) => {
  const me = current(req);
  const target = users.find(u => u.nick.toLowerCase() === req.params.nick.toLowerCase());
  if (!target) return res.status(404).json({ error: "Пользователь с таким ником не найден. Сначала он должен зарегистрироваться." });
  const requested = Number(req.body.level);
  if (![0, 20, 50, 100].includes(requested)) return res.status(400).json({ error: "Неизвестный уровень прав." });
  if (requested > me.level) return res.status(403).json({ error: "Нельзя выдать больше прав, чем есть у вас." });
  if (target.nick === me.nick && requested > me.level) return res.status(403).json({ error: "Нельзя повысить себя выше собственного уровня." });
  if (target.level >= me.level && target.nick !== me.nick) return res.status(403).json({ error: "Нельзя менять права сотрудника с равным или более высоким уровнем." });
  target.level = requested;
  write("users.json", users);
  res.json({ user: safeUser(target) });
});
app.patch("/api/users/:nick/title", mod, (req, res) => {
  const me = current(req);
  const target = users.find(u => u.nick.toLowerCase() === req.params.nick.toLowerCase());
  if (!target) return res.status(404).json({ error: "Пользователь не найден." });
  if (target.level >= me.level && target.nick !== me.nick) return res.status(403).json({ error: "Нельзя менять титул сотрудника с равным или более высоким уровнем." });
  const title = cleanText(req.body.title, 40), color = String(req.body.color || "");
  if (!validColor(color)) return res.status(400).json({ error: "Выберите корректный цвет." });
  target.title = title; target.titleColor = color;
  write("users.json", users); res.json({ user: safeUser(target) });
});

app.listen(PORT, '0.0.0.0', () => console.log(`CityLive RP Forum работает на порту ${PORT}`));
