import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

// Yapılandırma
const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model ayarları (Güvenlik filtrelerini kapattık ki argo konuşabilsin)
const model = genAI.getGenerativeModel({ 
  model: "models/gemini-1.5-flash",
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ],
});

// Veritabanı
const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    message_text TEXT,
    timestamp INTEGER
  )
`);

let botUsername: string;
bot.telegram.getMe().then((info) => {
  botUsername = info.username;
});

// Kişilik Talimatı (Soru-Cevap için)
const BILGE_PROMPT = `Sen tavernada takılan, her boku bilen, hafiften fırlama, alaycı ve ağzı bozuk bir tipsin. 
Sorulan sorulara ansiklopedi gibi cevap verme. Kısa kes, özünü söyle, cevabı verirken de hafiften taşak geç. 
Argodan kaçınma ama dozunda bırak. Karşındaki arkadaşınmış gibi konuş.`;

// 1. Ana Mesaj İşleyici
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);

  // Soru-Cevap Tetikleyici (@mention veya DM)
  if (isMentioned || isPrivate) {
    if (!text.startsWith('/')) {
      try {
        const userQuery = text.replace(`@${botUsername}`, '').trim();
        const chatPrompt = `${BILGE_PROMPT}\nSoru şu: ${userQuery}`;

        const result = await model.generateContent(chatPrompt);
        return await ctx.reply(result.response.text(), { reply_parameters: { message_id: ctx.message.message_id }});
      } catch (error) {
        console.error("Cevap hatası:", error);
      }
    }
  }

  // Mesaj Kaydı (Özet için)
  if (!text.startsWith('/')) {
    const stmt = db.prepare('INSERT INTO messages (user_name, message_text, timestamp) VALUES (?, ?, ?)');
    stmt.run(ctx.from.first_name, text, Date.now());
  }
  
  return next();
});

// 2. Özet Komutu
bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - (24 * 60 * 60 * 1000);
    const rows = db.prepare('SELECT user_name, message_text FROM messages WHERE timestamp > ?').all(birGunOnce) as any[];

    if (rows.length === 0) return ctx.reply("Buralar mezarlık gibiydi, kimse iki satır laf etmemiş ki özet geçeyim.");

    const sohbetGecmisi = rows.map(r => `${r.user_name}: ${r.message_text}`).join('\n');

    const summaryPrompt = `
      Aşağıdaki grup mesajlarını analiz et ve şu formatta bir özet geç:
      1. Genel Durum: Önce gruptaki genel muhabbeti alaycı, samimi ve hafif argolu bir dille anlat. Millet ne saçmalamış kısaca bahset.
      2. Kim Ne Karıştırdı?: Sonra madde madde hangi üye ne hakkında kafa ütülemiş yaz.
      
      Unutma: Dilin alaycı ve samimi olsun. Ansiklopedik dilden nefret edersin.
      
      Konuşmalar:
      ${sohbetGecmisi}
    `;

    const result = await model.generateContent(summaryPrompt);
    ctx.reply(result.response.text());
  } catch (error) {
    console.error("Özet hatası:", error);
    ctx.reply("Kafam bin dünya oldu, özet mözet çıkaramıyorum şu an.");
  }
});

bot.launch().then(() => console.log("🚀 Tavernanın fırlama bilgesi online!"));