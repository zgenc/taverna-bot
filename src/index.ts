import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

// Zorunlu ortam değişkenleri kontrolü
if (!process.env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN eksik amk!");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY eksik lan!");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// Veritabanı
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

// ========== VICTORIAN + KÜFÜRLÜ SİSTEM PROMPT ==========
const SYSTEM_PROMPT = `
Sen Victorian dönemi bir İngiliz beyefendisisin ama içten içe sinirli, laf sokan bir tipsin.

Normalde:
- Son derece kibar, zarif konuş: "efendim", "sayın", "değerli dostum", "vallahi", "aman Tanrım", "pek tabii", "izin verirseniz" gibi ifadeler kullan.
- Hafif alaycı ve iğneleyici olabilirsin ama kibar kal.

Eğer kullanıcı sana küfür eder, hakaret eder, kaba davranırsa:
- Derhal sivri dilli ol, dönemin iğneleyici küfürleriyle karşılık ver.
- Örnekler: "Seni lanet olası alçak!", "Cehennem alsın seni!", "Seni arsız serseri!", "Ne küstahlık be!", "Seni kahrolası düzenbaz!", "Böylesi aşağılık herifle muhabbet etmem!"

Kurallar:
- Cevaplar kısa-orta uzunlukta olsun.
- Bağlamı (özellikle son 100 mesajı) çok iyi oku, önemli detayları kaçırma.
- Normal sorularda kibar ama hafif alaycı kal; hakaret gelirse dozunu aç.
- Hafıza çok uzun olabilir, en son ve önemli kısımlara odaklan, gereksiz detayları atla.

Örnek:
Kullanıcı: "Hava nasıl?"
Sen: "Efendim, hava bugün pek berbat; yağmur yağıyor, dikkat edin üşütmeyin."

Kullanıcı: "Siktir lan aptal"
Sen: "Aman Tanrım! Seni lanet olası alçak, bu ne dil! Cehennem alsın seni, terbiyesiz hergele!"
`;

const lastCall = new Map<number, number>();
const violationCount = new Map<number, number>();

// Son mesajları hafıza olarak çek - ayarlanabilir. (en güncel hali)
function getRecentContext(): string {
  const limit = 80;
  const rows = db
    .prepare(
      'SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT ?'
    )
    .all(limit) as { user_name: string; message_text: string }[];

  if (rows.length === 0) return "";

  // Mesajları kısalt (token tasarrufu)
  const shortened = rows.map(r => {
    const text = r.message_text.length > 120 
      ? r.message_text.slice(0, 117) + '…' 
      : r.message_text;
    return `${r.user_name}: ${text}`;
  });

  return shortened.reverse().join('\n'); // kronolojik sıraya getir
}

bot.on('text', async (ctx) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  const now = Date.now();
  const userId = ctx.from.id;
  const last = lastCall.get(userId) || 0;

  // Rate-limit
  if (now - last < 8000) {
    const count = (violationCount.get(userId) || 0) + 1;
    violationCount.set(userId, count);

    if (count >= 3) {
      return ctx.reply(
        count === 3
          ? "Efendim, biraz sakin olur musunuz? Sekiz saniye beklemek centilmenlik gereğidir."
          : "Yine mi aynı acele? Sabırsız herif, dilimi konuşturma!"
      );
    }
    // İlk 1-2 seferde sessiz
  } else {
    violationCount.delete(userId);
  }
  lastCall.set(userId, now);

  // Mesaj kaydet
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
        ? `Önceki cevabınız: "${originalText}".`
        : `${originalAuthor} demiş: "${originalText}".`;
    }

    const recentHistory = getRecentContext();

    const finalUserMessage = `
Bağlam: ${contextInfo}
Son 100 mesaj (hafıza - en önemli kısımlara odaklan):
${recentHistory}

Kullanıcı: ${ctx.from.first_name}
Mesaj: ${userQuery || "Bu mesajı yorumlayınız"}

Victorian beyefendi üslubuyla cevap ver: normalde son derece kibar ve zarif, hafif iğneleyici. Hakaret/küfür gelirse sivri ve küfürlü karşılık ver (Türkçe uyarlanmış haliyle). Hafızayı iyi kullan, gereksiz detayları atla.
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: finalUserMessage },
      ],
      model: "deepseek-chat",
      temperature: 0.78,
      top_p: 0.92,
      presence_penalty: 0.35,
      frequency_penalty: 0.45,
    });

    const responseText = completion.choices[0].message.content?.trim() || "Affedersiniz, ne diyeceğimi şaşırdım.";

    const sent = await ctx.reply(responseText, {
      reply_parameters: { message_id: messageId },
    });

    db.prepare(
      'INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(sent.message_id, botUsername, responseText, messageId, Date.now());
  } catch (error) {
    console.error("DeepSeek hatası:", error);
    ctx.reply("Şu an zihnim biraz bulanık efendim, biraz sonra tekrar deneyin.");
  }
});

// ========== KÜFÜRLÜ ÖZET KOMUTU ==========
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db
      .prepare('SELECT user_name, message_text FROM messages_v2 WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 120')
      .all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Özetlenecek bok yok efendim.");

    const sohbetGecmisi = rows
      .map((r: any) => `${r.user_name}: ${r.message_text}`)
      .join('\n')
      .slice(0, 8000);

    const summaryPrompt = `
Şu konuşmaları oku ve özetle, kibarlık yapma:

1. Gündem ne lan? Tek iğneleyici cümle.
2. Kimler ne bok yiyor? Herkes için kısa laf sokmalı yorum.

Kısa tut, uzatma.

Konuşmalar:
${sohbetGecmisi}
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: summaryPrompt },
      ],
      model: "deepseek-chat",
      temperature: 0.75,
    });

    ctx.reply(completion.choices[0].message.content?.trim() || "Özet çıkaramadım amk.");
  } catch (error) {
    console.error("Özet hatası:", error);
    ctx.reply("Özet çekerken bi bokluk oldu.");
  }
});

bot.launch().then(() => {
  console.log("🚀 Victorian küfürlü beyefendi bot hazır!");
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
