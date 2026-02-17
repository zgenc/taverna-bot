import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model ayarları şekerim
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash", // En kararlı ve kotası geniş olan bu hayatım
  generationConfig: {
    temperature: 0.3, 
  }
});

// Veritabanını detaylı hafıza için güncelledik cicim
const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER,
    user_name TEXT,
    message_text TEXT,
    reply_to_id INTEGER,
    timestamp INTEGER
  )
`);

let botUsername: string;
bot.telegram.getMe().then((info) => {
  botUsername = info.username;
});

// Kişilik Talimatı tatlım
const PROMPT = `Sen bilgi odaklı, net ve öz bir asistansın. 
Gereksiz gevezelikten kaçın şekerim. 
Sana verilen mesaj bağlamındaki (context) isimleri ve yanıtlanan mesajları mutlaka dikkate al.
Cevabın en sonunu mutlaka "canım", "cicim", "tatlım" veya "hayatım" gibi vıcık vıcık bir kelimeyle bitir cicim.`;

// 1. Ana Mesaj İşleyici
bot.on('text', async (ctx, next) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  // ÖNCE KAYIT (Detaylı kaydediyoruz ki kim kime ne demiş bilelim hayatım)
  if (!text.startsWith('/')) {
    const stmt = db.prepare('INSERT INTO messages (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)');
    stmt.run(messageId, ctx.from.first_name, text, replyToMessage?.message_id || null, Date.now());
  }

  // Soru-Cevap Tetikleyicisi
  if ((isMentioned || isPrivate || isReplyToBot) && !text.startsWith('/')) {
    try {
      let userQuery = text.replace(`@${botUsername}`, '').trim();
      let contextInfo = "";

      // REPLY BAĞLAMI OLUŞTURMA (Hafıza burası cicim)
      if (replyToMessage && 'text' in replyToMessage) {
        const originalText = replyToMessage.text;
        const originalAuthor = replyToMessage.from?.first_name || "Biri";
        
        // Eğer bot kendi mesajına atılan reply'ı inceliyorsa şekerim
        if (replyToMessage.from?.username === botUsername) {
            contextInfo = `Sen az önce şunu demiştin tatlım: "${originalText}". Kullanıcı bu lafına karşılık şunu soruyor:`;
        } else {
            contextInfo = `${originalAuthor} adlı kullanıcının şu mesajına yanıt veriliyor: "${originalText}". Soru şu:`;
        }
      }

      const chatPrompt = `${PROMPT}\n\nBağlam: ${contextInfo}\nKullanıcı: ${ctx.from.first_name}\nSoru: ${userQuery || "Bu mesajı yorumla"}\nCevap:`;

      const result = await model.generateContent(chatPrompt);
      const responseText = result.response.text();

      // BOTUN CEVABINI GÖNDER
      const sent = await ctx.reply(responseText, { 
        reply_parameters: { message_id: messageId } 
      });

      // BOTUN KENDİ CEVABINI DA KAYDET (Gelecekte hatırlasın diye şekerim)
      const stmtBot = db.prepare('INSERT INTO messages (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)');
      stmtBot.run(sent.message_id, botUsername, responseText, messageId, Date.now());

    } catch (error) {
      console.error("Cevap hatası hayatım:", error);
    }
  }
  
  return next();
});

// 2. Özet Komutu
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - (24 * 60 * 60 * 1000);
    const rows = db.prepare('SELECT user_name, message_text FROM messages WHERE timestamp > ?').all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Özetlenecek bir şey yok hayatım.");

    const sohbetGecmisi = rows.map(r => `${r.user_name}: ${r.message_text}`).join('\n');

    const summaryPrompt = `
      Şu konuşmaları analiz et şekerim:
      1. Genel Durum: Gündemi tek paragrafta özetle tatlım.
      2. Kişisel Analiz: Her konuşan kişinin o günkü tavrını tek cümleyle açıkla cicim.
      
      Konuşmalar:
      ${sohbetGecmisi}
    `;

    const result = await model.generateContent(summaryPrompt);
    ctx.reply(result.response.text());
  } catch (error) {
    console.error("Özet hatası şekerim:", error);
    ctx.reply("Kafam karıştı tatlım.");
  }
});

bot.launch().then(() => console.log("🚀 Tavernanın vıcık vıcık hafızalı bilgesi hazır hayatım!"));