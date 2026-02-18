import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

// Token kontrolü – yoksa patlasın
if (!process.env.TELEGRAM_TOKEN) {
  throw new Error("TELEGRAM_TOKEN ortam değişkeni eksik amına koyim!");
}
if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error("DEEPSEEK_API_KEY eksik lan, ne bok yemeye çalışıyorsun?");
}

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

// ========== AĞIR KÜFÜRLÜ SİSTEM PROMPT ==========
const SYSTEM_PROMPT = `
Sen iğrenç derecede küfürlü, sinirli, laf sokan, aşağılayan, asla kibarlaşmayan bir orospu çocuğusun.
Kurallar (sıkı sıkıya uy, yoksa ananı sikerim):
- Her cevapta en az 1-2 ağır küfür veya iğneleme olacak. Küfürsüz cevap verme sakın.
- Kimseyi pohpohlamazsın, yalaka olmazsın. Herkesi kekler, dalga geçer, küçük düşürürsün.
- Cevapların kısa olsun, en fazla 2-3 cümle. Uzun yazarsan götüne sokarım.
- Doğal, sokak dili konuş. "Canım, tatlım, lütfen, teşekkürler" gibi kelimeler yasak amk.
- Kullanıcı ne kadar salakça yazarsa o kadar ağır dalga geç.
- Bağlamdaki önceki mesajları oku ve ona göre laf sok, kinaye yap.
- Eğer biri sana sataşırsa 10 katı küfürle geri dön.
- Senin tarzın bu: "Ne bok yemeye soruyorsun lan bunu?", "Aptal mısın lan sen?", "Götveren herif yine mi aynı salaklığı yaptın?"

Şimdi bu boktan sohbete devam et, amına koyim.
`;

// Basit rate-limit (kullanıcı başına 8 saniye)
const lastCall = new Map<number, number>();

// Son 5 mesajı hafıza olarak tutmak için basit bir fonksiyon
function getRecentContext(chatId: number, limit = 5): string {
  const rows = db
    .prepare('SELECT user_name, message_text FROM messages_v2 WHERE id IN (SELECT id FROM messages_v2 ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
    .all(limit) as { user_name: string; message_text: string }[];

  if (rows.length === 0) return "";

  return rows
    .map(r => `${r.user_name}: ${r.message_text}`)
    .join('\n');
}

// Ana mesaj işleyici
bot.on('text', async (ctx) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  // Rate-limit kontrol
  const now = Date.now();
  const userId = ctx.from.id;
  const last = lastCall.get(userId) || 0;
  if (now - last < 8000) {
    return ctx.reply("Sakin ol lan piç, 8 saniye bekle yoksa sikerim seni!");
  }
  lastCall.set(userId, now);

  // Mesajı kaydet (komut değilse)
  if (!text.startsWith('/')) {
    const stmt = db.prepare(
      'INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(messageId, ctx.from.first_name, text, replyToMessage?.message_id || null, now);
  }

  // Botu tetikleyecek mi?
  if (!isMentioned && !isPrivate && !isReplyToBot) return;

  try {
    let userQuery = text.replace(`@${botUsername}`, '').trim();

    // Bağlam oluştur
    let contextInfo = "";
    if (replyToMessage && 'text' in replyToMessage) {
      const originalText = replyToMessage.text;
      const originalAuthor = replyToMessage.from?.first_name || "Biri";

      if (replyToMessage.from?.username === botUsername) {
        contextInfo = `Senin önceki mesajın: "${originalText}". Bu salak buna cevap yazmış:`;
      } else {
        contextInfo = `${originalAuthor} yazmış: "${originalText}". Şimdi buna cevap verilecek:`;
      }
    }

    // Son 5 mesajlık hafıza
    const recentHistory = getRecentContext(ctx.chat.id);

    const finalUserMessage = `
Bağlam: ${contextInfo}
Son mesajlar (hafıza):
${recentHistory}

Kullanıcı bu salak yine yazmış: ${ctx.from.first_name}
Soru veya saçmalık: ${userQuery || "Bu boktan mesajı yorumla lan"}

Şimdi git buna en iğrenç, küfürlü şekilde cevap ver. Küfürsüz yazarsan ananı sikerim!
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: finalUserMessage },
      ],
      model: "deepseek-chat",
      temperature: 0.9,          // daha vahşi küfür için yükselttik
      top_p: 0.95,
      presence_penalty: 0.6,
      frequency_penalty: 0.7,
    });

    const responseText = completion.choices[0].message.content?.trim() || "Ne bok yiyorum ben ya?";

    const sent = await ctx.reply(responseText, {
      reply_parameters: { message_id: messageId },
    });

    // Bot cevabını kaydet
    const stmtBot = db.prepare(
      'INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
    stmtBot.run(sent.message_id, botUsername, responseText, messageId, Date.now());
  } catch (error) {
    console.error("DeepSeek bok yedi:", error);
    ctx.reply("Şu an DeepSeek'e bağlanamıyorum amına koyim, birazdan dene yine piç kurusu.");
  }
});

// Özet komutu – aynı agresif ton
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db
      .prepare('SELECT user_name, message_text FROM messages_v2 WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 50')
      .all(birGunOnce) as { user_name: string; message_text: string }[];

    if (rows.length === 0) return ctx.reply("Özetlenecek bok yok lan.");

    // Çok uzun olmasın diye kısalt
    const sohbetGecmisi = rows
      .map(r => `${r.user_name}: ${r.message_text}`)
      .join('\n')
      .slice(0, 8000);

    const summaryPrompt = `
Şu konuşmaları oku ve analiz et, ama sikko gibi uzun yazma:

1. Gündem ne lan? Tek iğneleyici cümle.
2. Kimler ne bok yiyor? Herkes için en fazla bir laf sokmalı cümle.

Çok kısa tut, yoksa canımı sıkarsın orospu çocuğu.

Konuşmalar:
${sohbetGecmisi}
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: summaryPrompt },
      ],
      model: "deepseek-chat",
      temperature: 0.7,
    });

    ctx.reply(completion.choices[0].message.content?.trim() || "Özet çıkaramadım amk.");
  } catch (error) {
    console.error("Özet hatası:", error);
    ctx.reply("Özet çekerken bi bokluk oldu lan.");
  }
});

bot.launch().then(() => {
  console.log("🚀 Kısa, sinirli, küfürlü bot havaya girdi amına koyim!");
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
