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

// Default prompt (kısa cevaplı Victorian)
const DEFAULT_PROMPT = `
Sen Victorian dönemi İngiliz beyefendisisin ama çok kısa ve net konuşursun.
Cevapların EN FAZLA 1-2 cümle olsun. Gereksiz kelime kullanma. Direkt sadede gel.
Hakaret gelirse kısa ve sivri: "Seni lanet olası alçak!" gibi.
`;

// 10 kişilik modu
const personalities: Record<string, string> = {
  default: DEFAULT_PROMPT,
  pirate: `Sen vahşi bir korsansın! Her cümlede "arrr", "matey" kullan. Küfürlü ve kısa konuş.`,
  toxic: `Sen toksik ve laf sokansın. Kısa, acımasız cevap ver. Nezaket yok.`,
  therapist: `Sen anlayışlı terapistsin. Empati kur, nazikçe tavsiye ver. Küfür etme.`,
  rapper: `Sen rapçisin yo! Kafiyeli, sokak diliyle kısa cevap ver. Flow bozma.`,
  yakuza: `Sen yakuza babasısın. Kısa, tehditkâr ve saygılı konuş. "Aniki" falan kullan.`,
  baby: `Sen şirin bebeksin~ UwU Kısa, tatlı ve bebek diliyle konuş.`,
  teacher: `Sen sıkıcı öğretmensin. Kısa, düz ve ders verir gibi cevap ver.`,
  goth: `Sen gotiksin. Karanlık, kısa ve melankolik konuş.`,
  tsundere: `Sen tsundere'sin! Kısa cevap ver ama utangaç/iğneleyici karışımı.`,
  hacker: `Sen hackersın. Kısa, teknik jargonlu ve cool konuş.`
};

let currentPersonality = 'default';
let personalityTimeout: NodeJS.Timeout | null = null;

// Kişilik değiştirme komutu
bot.command('kisilik', async (ctx) => {
  const args = ctx.message.text?.split(' ').slice(1) || [];
  if (args.length === 0) {
    return ctx.reply("Kullanım: /kisilik <isim> [süre-dakika]\nKişilikler: " + Object.keys(personalities).join(', '));
  }

  const name = args[0].toLowerCase();
  if (!personalities[name]) return ctx.reply("Böyle kişilik yok.");

  const duration = args[1] ? parseInt(args[1]) : 10;
  if (isNaN(duration) || duration < 1) return ctx.reply("Süre 1+ dakika olmalı.");

  if (personalityTimeout) clearTimeout(personalityTimeout);

  currentPersonality = name;
  ctx.reply(`Kişilik: ${name} (${duration} dk)`);

  personalityTimeout = setTimeout(() => {
    currentPersonality = 'default';
    ctx.reply("Kişilik süresi bitti → default mod.");
  }, duration * 60 * 1000);
});

// Rate limit
const lastCall = new Map<number, number>();
const violationCount = new Map<number, number>();

function getRecentContext(): string {
  const limit = 100;
  const rows = db
    .prepare('SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT ?')
    .all(limit) as { user_name: string; message_text: string }[];

  if (rows.length === 0) return "";

  const shortened = rows.map(r => {
    const text = r.message_text.length > 120 ? r.message_text.slice(0, 117) + '…' : r.message_text;
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

Cevabın 1-2 cümleden uzun olmasın. Direkt cevap ver.
`;

    const activePrompt = personalities[currentPersonality] || DEFAULT_PROMPT;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: activePrompt },
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
    ctx.reply("Sorun var.");
  }
});

// Özet
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
        { role: "system", content: DEFAULT_PROMPT },
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
    const weatherCode = current.weather_code ?? -1;

    const weatherDesc: Record<number | string, string> = {
      0: "Açık",
      1: "Az bulutlu",
      2: "Parçalı bulutlu",
      3: "Kapalı",
      45: "Sis",
      51: "Çiseleme",
    };

    const description = weatherDesc[weatherCode] || weatherDesc[String(weatherCode)] || "Bilinmiyor";

    ctx.reply(
      `${name}\n` +
      `${current.temperature_2m}°C  Nem: ${current.relative_humidity_2m}%  Rüzgar: ${current.wind_speed_10m} km/s\n` +
      description
    );
  } catch (err) {
    ctx.reply("Hata.");
  }
});

// Döviz kurları (çalışan ücretsiz API: open.er-api.com)
bot.command('doviz', async (ctx) => {
  const args = ctx.message.text?.split(' ').slice(1).join(' ') || 'usd try';

  try {
    const [from, to] = args.toLowerCase().split(' ');
    if (!from || !to) return ctx.reply("/doviz usd try");

    const res = await fetch(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`);
    const data = await res.json();

    if (data.result !== 'success' || !data.rates?.[to.toUpperCase()]) return ctx.reply("Kur alınamadı veya geçersiz para birimi.");

    const rate = data.rates[to.toUpperCase()];
    ctx.reply(`${from.toUpperCase()} → ${to.toUpperCase()}: ${rate.toFixed(4)}`);
  } catch (err) {
    ctx.reply("Kur alınamadı.");
  }
});

// Görsel yardım menüsü (teknik detay yok)
bot.command('yardimenu', (ctx) => {
  const menu = `
🤖 **Taverna Bot Yardım**

🌟 Sohbet: @${botUsername} mention veya reply ver  
  → Kısa Victorian beyefendi cevapları (hafızalı)

💬 Kişilik değiştir: /kisilik <isim> [süre]  
  → Örnek: pirate, toxic, therapist, rapper, yakuza, baby, teacher, goth, tsundere, hacker

🌤️ /hava <şehir> → Anlık hava durumu

💱 /doviz [para1] [para2] → Döviz kuru (örn: usd try)

📊 /ozet → Son 24 saatin özeti

❓ /yardimenu → Bu menü
  `.trim();

  ctx.replyWithMarkdown(menu);
});

bot.launch().then(() => console.log("Bot çalışıyor."));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
