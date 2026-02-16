import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

// Çevresel değişken kontrolü
if (!process.env.TELEGRAM_TOKEN || !process.env.GEMINI_API_KEY) {
  console.error("HATA: .env dosyasında eksik bilgi var!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const db = new Database('chat.db');

// SQLite Tablo Kurulumu
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    message_text TEXT,
    timestamp INTEGER
  )
`);

// 1. Mesaj Dinleyici: Gelen her mesajı veritabanına kaydeder
bot.on('text', (ctx, next) => {
  // Komutları (/ozet gibi) veritabanına kaydetmemek için
  if (ctx.message.text.startsWith('/')) return next();
  
  // Sadece grup mesajlarını kaydet (isteğe bağlı)
  if (ctx.chat.type !== 'private') {
    const stmt = db.prepare('INSERT INTO messages (user_name, message_text, timestamp) VALUES (?, ?, ?)');
    stmt.run(ctx.from.first_name, ctx.message.text, Date.now());
  }
  return next();
});

bot.use(async (ctx, next) => {
  console.log("------------------------------------");
  console.log(`📥 Herhangi bir etkileşim geldi! Tip: ${ctx.updateType}`);
  if (ctx.message) {
    console.log(`📝 İçerik: ${(ctx.message as any).text}`);
  }
  return next();
});

// 2. Özet Komutu: /ozet
bot.command('ozet', async (ctx) => {
  await ctx.sendChatAction('typing');

  // Son 24 saatin mesajlarını çek
  const birGunOnce = Date.now() - (24 * 60 * 60 * 1000);
  const rows = db.prepare('SELECT user_name, message_text FROM messages WHERE timestamp > ? ORDER BY timestamp ASC').all(birGunOnce) as {user_name: string, message_text: string}[];

  if (rows.length === 0) {
    return ctx.reply("Son 24 saatte henüz kaydedilmiş bir mesaj bulamadım.");
  }

  // Mesajları AI için formatla
  const sohbetGecmisi = rows.map(r => `${r.user_name}: ${r.message_text}`).join('\n');

  try {
    const prompt = `Sen bir grup asistanısın. Aşağıdaki grup konuşmalarını analiz et. Önemli olayları, kararları ve konuları esprili, kısa ve öz bir şekilde maddeler halinde özetle:\n\n${sohbetGecmisi}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    ctx.reply(text || "Özet oluşturulamadı.");
  } catch (error) {
    console.error("Gemini Hatası:", error);
    ctx.reply("Gemini ile konuşurken bir hata oluştu.");
  }
});

bot.launch().then(() => console.log("🤖 Bot çalışmaya başladı!"));

// Güvenli kapatma
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));