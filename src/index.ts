import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

// Yapılandırma
const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model ayarları: Temperature düşük, odak yüksek şekerim
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.3, 
  }
});

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

let botUsername: string;
bot.telegram.getMe().then((info) => {
  botUsername = info.username;
});

// Kişilik Talimatı
const PROMPT = `Sen bilgi odaklı, net ve öz bir asistansın. 
Gereksiz betimlemelerden, dolaylı anlatımlardan ve gevezelikten kaçın şekerim. 
Sadece istenen bilgiyi veya özeti, en az kelimeyle en çok anlamı ifade edecek şekilde ver tatlım. 
Asla alaycı konuşma ve argo kullanma. 
Cevabın en sonunu mutlaka "canım", "cicim", "tatlım" veya "hayatım" gibi vıcık vıcık bir kelimeyle bitir cicim.`;

// 1. Ana Mesaj İşleyici (Kayıt ve Soru-Cevap)
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const replyToMessage = ctx.message.reply_to_message;
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  // 1. GELEN MESAJI KAYDET (Hafıza için cicim)
  if (!text.startsWith('/')) {
    const stmt = db.prepare('INSERT INTO messages (user_name, message_text, timestamp) VALUES (?, ?, ?)');
    stmt.run(ctx.from.first_name, text, Date.now());
  }

  // 2. CEVAP TETİKLEYİCİSİ
  if ((isMentioned || isPrivate || isReplyToBot) && !text.startsWith('/')) {
    try {
      let userQuery = text.replace(`@${botUsername}`, '').trim();
      let finalPrompt = "";

      // BAĞLAM OLUŞTURMA
      if (replyToMessage && 'text' in replyToMessage) {
        const originalText = replyToMessage.text;
        const originalAuthor = replyToMessage.from?.first_name || "Biri";
        
        // Eğer botun kendi mesajına reply atıldıysa şekerim
        const botunKendiCevabiMi = replyToMessage.from?.username === botUsername;
        
        if (botunKendiCevabiMi) {
            finalPrompt = `Sen daha önce şunu demiştin: "${originalText}". \nKullanıcı bu cevabına istinaden şunu soruyor: ${userQuery || "Bu cevabı kime/neye istinaden verdin?"}`;
        } else {
            finalPrompt = `Yanıtlanan mesaj: "${originalAuthor}: ${originalText}"\nKullanıcının sorusu: ${userQuery}`;
        }
      } else {
        finalPrompt = userQuery;
      }

      if (!finalPrompt || finalPrompt.trim() === "") {
        return await ctx.reply("Açıklamam için bir metin veya ifade belirtmelisin, canım.");
      }

      const chatPrompt = `${PROMPT}\n\nİçerik: ${finalPrompt}\nCevap:`;
      const result = await model.generateContent(chatPrompt);
      const responseText = result.response.text();

      // BOTUN CEVABINI GÖNDER VE ONU DA KAYDET (HAYATİ KISIM BURASI ŞEKERİM)
      const sentMessage = await ctx.reply(responseText, { 
        reply_parameters: { message_id: ctx.message.message_id } 
      });

      // Botun kendi cevabını da veritabanına ekliyoruz ki sonra hatırlasın cicim
      const stmt = db.prepare('INSERT INTO messages (user_name, message_text, timestamp) VALUES (?, ?, ?)');
      stmt.run(botUsername, responseText, Date.now());

      return sentMessage;

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

    if (rows.length === 0) return ctx.reply("Özetlenecek bir şey bulamadım hayatım.");

    const sohbetGecmisi = rows.map(r => `${r.user_name}: ${r.message_text}`).join('\n');

    // İstediğin o spesifik tutum analizi talimatı burada şekerim:
    const summaryPrompt = `
      Aşağıdaki sohbet geçmişini analiz et tatlım.
      
      Senden iki şey istiyorum cicim:
      1. Genel Durum: Grubun bugünkü ana gündemini ve havasını tek bir paragrafta özetle hayatım.
      2. Kim Ne Yaptı?: Konuşan her bir kişiyi ayrı ayrı ele al. O kişinin mesajlarının listesini verme! Bunun yerine o kişinin bugünkü genel tutumunu, neyin peşinde olduğunu veya ana odağını tek bir cümleyle çıkar cicim. (Örn: "Zafer: Bugün daha çok teknik hatalarla boğuştu ve çözüm arayışındaydı.")
      
      Format:
      **Genel Durum:** [Özet buraya]
      **Kişisel Analizler:**
      - [Kişi Adı]: [Tek cümlelik tutum analizi]

      Konuşmalar:
      ${sohbetGecmisi}

      Unutma şekerim, cevabın en sonu vıcık vıcık bitmeli!
    `;

    const result = await model.generateContent(summaryPrompt);
    ctx.reply(result.response.text());
  } catch (error) {
    console.error("Özet hatası şekerim:", error);
    ctx.reply("Bir hata oluştu tatlım.");
  }
});

bot.launch().then(() => console.log("🚀 Vıcık vıcık asistanın hazır hayatım!"));