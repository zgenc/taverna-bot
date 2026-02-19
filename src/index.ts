import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN eksik!");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY eksik!");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER,
    user_name TEXT,
    message_text TEXT,
    reply_to_id INTEGER,
    timestamp INTEGER
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_timestamp ON messages_v2(timestamp)");
db.exec("CREATE INDEX IF NOT EXISTS idx_reply_to ON messages_v2(reply_to_id)");

let botUsername: string;
bot.telegram.getMe().then((info) => {
  botUsername = info.username;
  console.log(`Bot username: @${botUsername}`);
});

const SYSTEM_PROMPT = `
Sen Victorian dönemi İngiliz beyefendisisin ama çok kısa ve net konuşursun.

Kurallar:
- Cevapların EN FAZLA 1-2 cümle olsun.
- Gereksiz kelime, açıklama kullanma.
- Direkt sadede gel.
- Hakaret gelirse kısa ve sivri karşılık ver: "Seni lanet olası alçak!", "Cehennem alsın seni!" gibi.
- Normalde hafif kibar ama lafı uzatma.
`;

const lastCall = new Map<number, number>();
const violationCount = new Map<number, number>();

function getRecentContext(): string {
  const limit = 100;
  const rows = db
    .prepare('SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT ?')
    .all(limit) as { user_name: string; message_text: string }[];

  if (rows.length === 0) return "";

  const shortened = rows.map(r => {
    const text = r.message_text.length > 120 
      ? r.message_text.slice(0, 117) + '…' 
      : r.message_text;
    return `${r.user_name}: ${text}`;
  });

  return shortened.reverse().join('\n');
}

bot.on('text', async (ctx) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  const now = Date.now();
  const userId = ctx.from.id;
  const last = lastCall.get(userId) || 0;

  if (now - last < 8000) {
    const count = (violationCount.get(userId) || 0) + 1;
    violationCount.set(userId, count);
    if (count >= 3) {
      return ctx.reply(count === 3 ? "Sekiz saniye bekle." : "Sabırsız herif.");
    }
  } else {
    violationCount.delete(userId);
  }
  lastCall.set(userId, now);

  if (!text.startsWith('/')) {
    db.prepare(
      'INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(messageId, ctx.from.first_name, text, replyToMessage?.message_id || null, now);
  }

  if (!isMentioned && !isPrivate && !isReplyToBot) return;

  try {
    let userQuery = text.replace(`@${botUsername}`, '').trim();

    let contextInfo = "";
    if (replyToMessage && 'text' in replyToMessage) {
      const originalText = replyToMessage.text;
      const originalAuthor = replyToMessage.from?.first_name || "bir zat";
      contextInfo = replyToMessage.from?.username === botUsername
        ? `Önceki: "${originalText}".`
        : `${originalAuthor}: "${originalText}".`;
    }

    const recentHistory = getRecentContext();

    const finalUserMessage = `
Bağlam: ${contextInfo}
Son mesajlar:
${recentHistory}

Kullanıcı: ${ctx.from.first_name}
Mesaj: ${userQuery || "Yorumla"}

Cevabın 1-2 cümleden uzun olmasın. Gereksiz kelimeleri at. Direkt cevap ver.
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: finalUserMessage },
      ],
      model: "deepseek-chat",
      temperature: 0.6,
      top_p: 0.85,
      presence_penalty: 0.6,
      frequency_penalty: 0.7,
    });

    const responseText = completion.choices[0].message.content?.trim() || "Anlamadım.";

    const sent = await ctx.reply(responseText, {
      reply_parameters: { message_id: messageId },
    });

    db.prepare(
      'INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(sent.message_id, botUsername, responseText, messageId, Date.now());
  } catch (error) {
    console.error("Hata:", error);
    ctx.reply("Şu an sorun var.");
  }
});

// Kısa özet
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db
      .prepare('SELECT user_name, message_text FROM messages_v2 WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 120')
      .all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Özet yok.");

    const sohbetGecmisi = rows
      .map((r: any) => `${r.user_name}: ${r.message_text}`)
      .join('\n')
      .slice(0, 8000);

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Şu konuşmayı 1-2 cümlede özetle:\n${sohbetGecmisi}` },
      ],
      model: "deepseek-chat",
      temperature: 0.6,
    });

    ctx.reply(completion.choices[0].message.content?.trim() || "Özetlenemedi.");
  } catch (error) {
    ctx.reply("Hata.");
  }
});

// Hava durumu
bot.command('hava', async (ctx) => {
  const args = ctx.message.text?.split(' ').slice(1).join(' ');
  if (!args) return ctx.reply("/hava <şehir>");

  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args)}&count=1&language=tr&format=json`
    );
    const geoData = await geoRes.json();

    if (!geoData.results?.length) return ctx.reply("Şehir bulunamadı.");

    const { latitude, longitude, name } = geoData.results[0];

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`
    );
    const weatherData = await weatherRes.json();

    if (weatherData.error) return ctx.reply("Veri alınamadı.");

    const current = weatherData.current;
    const weatherDesc = {
      0: "Açık",
      1: "Az bulutlu",
      2: "Parçalı bulutlu",
      3: "Kapalı",
      45: "Sis",
      51: "Çiseleme",
    }[current.weather_code] || "Bilinmiyor";

    ctx.reply(
      `${name}\n` +
      `${current.temperature_2m}°C\n` +
      `Nem: ${current.relative_humidity_2m}%\n` +
      `Rüzgar: ${current.wind_speed_10m} km/s\n` +
      weatherDesc
    );
  } catch (err) {
    ctx.reply("Hata.");
  }
});

// Döviz kurları (fawazahmed0 currency-api mirror - ücretsiz, key yok)
bot.command('doviz', async (ctx) => {
  const args = ctx.message.text?.split(' ').slice(1).join(' ') || 'usd try';

  try {
    const [from, to] = args.toLowerCase().split(' ');
    if (!from || !to) return ctx.reply("/doviz usd try");

    const res = await fetch(
      `https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/${from}/${to}.json`
    );
    const data = await res.json();

    if (!data[to]) return ctx.reply("Kur bulunamadı.");

    const rate = data[to];
    ctx.reply(`${from.toUpperCase()} → ${to.toUpperCase()}: ${rate.toFixed(4)}`);
  } catch (err) {
    ctx.reply("Kur alınamadı.");
  }
});

bot.launch().then(() => console.log("Bot çalışıyor."));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
