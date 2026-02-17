import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');

// DeepSeek Bağlantısı
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY || ''
});

// Veritabanı (Mevcut yapıyı koruyoruz)
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

let botUsername: string;
bot.telegram.getMe().then((info) => {
  botUsername = info.username;
});

// YENİ SİSTEM TALİMATI: Kısa, net, normal konuşma.
const SYSTEM_PROMPT = `Sen yardımcı bir asistansın. 
Kurallar:
1. Yanıtların her zaman çok kısa ve net olsun.
2. Doğal bir konuşma dili kullan ama gereksiz nezaket sözcüklerinden (canım, cicim vb.) kaçın.
3. Uzun açıklamalar yapma, direkt sadede gel.
4. Sana verilen mesaj bağlamındaki (context) isimleri ve yanıtlanan mesajları dikkate al.`;

// 1. Ana Mesaj İşleyici
bot.on('text', async (ctx, next) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  // KAYIT
  if (!text.startsWith('/')) {
    const stmt = db.prepare('INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)');
    stmt.run(messageId, ctx.from.first_name, text, replyToMessage?.message_id || null, Date.now());
  }

  // Soru-Cevap Tetikleyicisi
  if ((isMentioned || isPrivate || isReplyToBot) && !text.startsWith('/')) {
    try {
      let userQuery = text.replace(`@${botUsername}`, '').trim();
      let contextInfo = "";

      // BAĞLAM OLUŞTURMA (Temiz dil)
      if (replyToMessage && 'text' in replyToMessage) {
        const originalText = replyToMessage.text;
        const originalAuthor = replyToMessage.from?.first_name || "Biri";
        
        if (replyToMessage.from?.username === botUsername) {
            contextInfo = `Senin önceki mesajın: "${originalText}". Kullanıcı buna istinaden soruyor:`;
        } else {
            contextInfo = `${originalAuthor} kişisinin mesajına yanıt veriliyor: "${originalText}". Soru:`;
        }
      }

      // DeepSeek'e Gönderilecek Mesaj
      const finalUserMessage = `Bağlam: ${contextInfo}\nKullanıcı: ${ctx.from.first_name}\nSoru: ${userQuery || "Bu mesajı yorumla"}`;

      const completion = await openai.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: finalUserMessage }
        ],
        model: "deepseek-chat", 
        temperature: 0.7, 
      });

      const responseText = completion.choices[0].message.content || "Bir hata oluştu.";

      // BOTUN CEVABINI GÖNDER
      const sent = await ctx.reply(responseText, { 
        reply_parameters: { message_id: messageId } 
      });

      // BOTUN CEVABINI KAYDET
      const stmtBot = db.prepare('INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)');
      stmtBot.run(sent.message_id, botUsername, responseText, messageId, Date.now());

    } catch (error) {
      console.error("DeepSeek hatası:", error);
      ctx.reply("Şu an cevap veremiyorum, sonra tekrar dene.");
    }
  }
  
  return next();
});

// 2. Özet Komutu (Kısa ve öz)
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - (24 * 60 * 60 * 1000);
    const rows = db.prepare('SELECT user_name, message_text FROM messages_v2 WHERE timestamp > ?').all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Özetlenecek mesaj yok.");

    const sohbetGecmisi = rows.map(r => `${r.user_name}: ${r.message_text}`).join('\n');

    const summaryPrompt = `
      Şu konuşmaları analiz et.
      1. Genel Durum: Gündemi tek cümleyle özetle.
      2. Kişisel Analiz: Konuşan kişilerin neye odaklandığını kişi başı en fazla bir cümleyle anlat.
      
      Çok kısa ve öz tut. Gereksiz detay verme.
      
      Konuşmalar:
      ${sohbetGecmisi}
    `;

    const completion = await openai.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: summaryPrompt }
        ],
        model: "deepseek-chat",
        temperature: 0.5,
      });

    ctx.reply(completion.choices[0].message.content || "Özet çıkarılamadı.");
  } catch (error) {
    console.error("Özet hatası:", error);
    ctx.reply("Bir hata oluştu.");
  }
});

bot.launch().then(() => console.log("🚀 Kısa ve öz konuşan bot hazır!"));