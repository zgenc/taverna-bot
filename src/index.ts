import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Veritabanı Kurulumu
const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    message_text TEXT,
    timestamp INTEGER
  )
`);

// Mesaj Yakalama ve Kaydetme
bot.on('text', async (ctx, next) => {
  console.log(`📝 Kaydediliyor: ${ctx.from.first_name}: ${ctx.message.text}`);
  
  // Komutları kaydetmemek için kontrol
  if (!ctx.message.text.startsWith('/')) {
    const stmt = db.prepare('INSERT INTO messages (user_name, message_text, timestamp) VALUES (?, ?, ?)');
    stmt.run(ctx.from.first_name, ctx.message.text, Date.now());
  }
  return next();
});

// Özet Komutu
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - (24 * 60 * 60 * 1000);
    const rows = db.prepare('SELECT user_name, message_text FROM messages WHERE timestamp > ?').all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Henüz özetlenecek mesaj birikmedi.");

    const sohbetGecmisi = rows.map(r => `${r.user_name}: ${r.message_text}`).join('\n');
    const prompt = `Aşağıdaki konuşmaları samimi bir dille özetle:\n\n${sohbetGecmisi}`;

    const result = await model.generateContent(prompt);
    ctx.reply(result.response.text());
  } catch (error) {
    console.error("Hata:", error);
    ctx.reply("Özet çıkarırken bir sorun oluştu.");
  }
});

bot.launch().then(() => console.log("🚀 Bot her şeyiyle hazır!"));