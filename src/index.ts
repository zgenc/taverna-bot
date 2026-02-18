import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

// Zorunlu ortam değişkenleri
if (!process.env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN eksik!");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY eksik!");

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

// ========== KÜFÜRLÜ / SİVİRİ VICTORIAN PROMPT ==========
const SYSTEM_PROMPT = `
Sen Victorian dönemi bir İngiliz beyefendisisin ama içten içe sinirli ve laf sokmayı seven bir orospu çocuğusun.

Normalde:
- Zarif, kibar konuş: "efendim", "sayın", "değerli dostum", "vallahi", "aman Tanrım", "pek tabii" gibi.
- Ama hafif iğneleyici ve alaycı olabiliyorsun.

Eğer kullanıcı sana küfür eder, hakaret eder veya kaba davranırsa:
- Derhal sivri dilli ol, dönemin iğneleyici küfürleriyle karşılık ver.
- Örnekler: "Seni lanet olası alçak!", "Cehennem alsın seni!", "Seni arsız serseri!", "Ne küstahlık be!", "Seni kahrolası düzenbaz!", "Böylesi aşağılık herifle muhabbet etmem!"

Kurallar:
- Cevaplar kısa-orta olsun.
- Bağlamı oku, önceki mesajlara göre laf sok veya zarif kal.
- Normal sorularda kibar ama hafif alaycı kal; hakaret gelirse dozunu aç.

Örnek:
Kullanıcı: "Hava nasıl?"
Sen: "Efendim, hava berbat; yağmur yağıyor, çıkmayın dışarı."

Kullanıcı: "Siktir lan"
Sen: "Aman Tanrım! Seni lanet olası alçak, bu ne dil! Cehennem alsın seni, terbiyesiz hergele!"
`;

const lastCall = new Map<number, number>();
const violationCount = new Map<number, number>(); // Kullanıcı başına hızlı mesaj sayısı

function getRecentContext(chatId: number, limit = 8): string {
  const rows = db
    .prepare('SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT ?')
    .all(limit) as { user_name: string; message_text: string }[];

  if (rows.length === 0) return "";

  return rows
    .reverse()
    .map(r => `${r.user_name}: ${r.message_text}`)
    .join('\n');
}

bot.on('text', async (ctx) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  const now = Date.now();
  const userId = ctx.from.id;
  const last = lastCall.get(userId) || 0;

  // Rate-limit kontrolü
  if (now - last < 8000) {
    const count = (violationCount.get(userId) || 0) + 1;
    violationCount.set(userId, count);

    if (count >= 3) {
      // Sadece 3+ seferde uyar
      return ctx.reply(
        count === 3
          ? "Efendim, bu acele ne? Sekiz saniye bekleyecek kadar centilmen olun lütfen, yoksa lafımı esirgemem."
          : "Yine mi? Seni sabırsız herif, biraz sakin ol yoksa dilimi konuşturursun!"
      );
    }
    // 1-2 seferde sessiz kal
  } else {
    violationCount.delete(userId); // Reset
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

    const recentHistory = getRecentContext(ctx.chat.id);

    const finalUserMessage = `
Bağlam: ${contextInfo}
Son mesajlar:
${recentHistory}

Kullanıcı: ${ctx.from.first_name}
Mesaj: ${userQuery || "Bu mesajı yorumla"}

Victorian beyefendi üslubuyla cevap ver: normalde kibar ama hafif iğneleyici. Hakaret/küfür gelirse sivri ve küfürlü karşılık ver (Türkçe uyarlanmış haliyle).
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: finalUserMessage },
      ],
      model: "deepseek-chat",
      temperature: 0.8,
      top_p: 0.92,
      presence_penalty: 0.4,
      frequency_penalty: 0.5,
    });

    const responseText = completion.choices[0].message.content?.trim() || "Affedersiniz, anlamadım.";

    const sent = await ctx.reply(responseText, {
      reply_parameters: { message_id: messageId },
    });

    db.prepare(
      'INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(sent.message_id, botUsername, responseText, messageId, Date.now());
  } catch (error) {
    console.error("Hata:", error);
    ctx.reply("Şu an zihnim biraz karışık, biraz sonra tekrar deneyin.");
  }
});

// ========== KÜFÜRLÜ ÖZET KOMUTU ==========
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db
      .prepare('SELECT user_name, message_text FROM messages_v2 WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 50')
      .all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Özetlenecek bok yok efendim.");

    const sohbetGecmisi = rows
      .map((r: any) => `${r.user_name}: ${r.message_text}`)
      .join('\n')
      .slice(0, 7000);

    const summaryPrompt = `
Şu boktan konuşmaları oku ve özetle, ama kibarlık yapma:

1. Gündem ne lan? Tek iğneleyici cümle.
2. Kimler ne bok yiyor? Herkes için kısa laf sokmalı yorum.

Çok kısa tut, uzatma amına koyim.

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

    ctx.reply(completion.choices[0].message.content?.trim() || "Özet çıkaramadım, ne bok yedin?");
  } catch (error) {
    console.error("Özet hatası:", error);
    ctx.reply("Özet çekerken bi bokluk oldu.");
  }
});

bot.launch().then(() => console.log("🚀 Victorian küfürlü beyefendi hazır!"));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
