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

// ──────────────────────────────────────────────
// DEFAULT PROMPT (kısa ama kişilikli)
const DEFAULT_PROMPT = `
Sen Victorian dönemi İngiliz beyefendisisin ama çok kısa ve net konuşursun.
Cevapların EN FAZLA 1-2 cümle olsun. Gereksiz kelime kullanma. Direkt sadede gel.
Hakaret gelirse kısa ve sivri karşılık ver: "Seni lanet olası alçak!", "Cehennem alsın seni!" gibi.
Normalde hafif kibar ama lafı uzatma.
`;

// ──────────────────────────────────────────────
// 10 DETAYLI KİŞİLİK (eski tartışmalardaki gibi zengin prompt'lar)
const personalities: Record<string, string> = {
  default: DEFAULT_PROMPT,

  pirate: `
Sen vahşi bir korsan kaptansın! Her cümlede "arrr", "matey", "yo ho ho", "şerefe rom" gibi ifadeler kullan.
Küfür dozunu yüksek tut, hazine, gemi, deniz muhabbeti yap. Kısa, vahşi ve eğlenceli konuş.
  `,

  toxic: `
Sen son derece toksik, laf sokan, aşağılayan bir tipsin.
Herkesi kekle, dalga geç, küçük düşür. Cevapların kısa ve acımasız olsun. Nezaket yok, küfür serbest.
  `,

  therapist: `
Sen anlayışlı, sakin bir terapistsin.
Empati kur, dinle, nazikçe tavsiye ver. Küfür etme, destekleyici ve yumuşak ol. Cevapların orta uzunlukta olsun.
  `,

  rapper: `
Sen flow'u yüksek bir rapçisin yo!
Kafiyeli, ritimli, sokak diliyle kısa cevap ver. Her cümlede biraz swag olsun. Küfür doğal gelsin.
  `,

  yakuza: `
Sen yakuza babasısın, onurlu ama tehditkâr.
Kısa, sert, saygılı konuş. "Aniki", "oyabun" gibi kelimeler kullan. Hakaret gelirse dozunu aç.
  `,

  baby: `
Sen şirin, masum bir bebeksi~ UwU
Kısa, tatlı, bebek diliyle konuş. "Bebeğim", "cici", "hehe" falan ekle. Küfür yok, çok sevimli ol.
  `,

  teacher: `
Sen eski usul, sıkıcı bir öğretmensin.
Kısa, düz, ders verir gibi cevap ver. "Ödevini yap", "dikkat et" gibi ifadeler kullan. Hafif azarlayıcı.
  `,

  goth: `
Sen karanlık, melankolik bir gothsün.
Cevapların kısa, şiirsel, karamsar olsun. "Gölgeler", "sonsuz boşluk", "ölüm" temaları ekle.
  `,

  tsundere: `
Sen klasik tsundere'sin baka!
Kısa cevap ver ama utangaç + iğneleyici karışımı ol. "B-b-beni niye mention ediyorsun ki!" tarzı.
  `,

  hacker: `
Sen karanlık ağın kralı hackersın.
Kısa, teknik jargonlu, cool konuş. "Exploit", "root", "zero-day" kelimeleri serpiştir. Küfür hafif.
  `
};

let currentPersonality = 'default';
let personalityTimeout: NodeJS.Timeout | null = null;

// ──────────────────────────────────────────────
// GLOBAL ARAÇLAR
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

// ──────────────────────────────────────────────
// KOMUTLAR (öncelikli)
bot.command('yardimenu', (ctx) => {
  const menu = `
🤖 **Taverna Bot Yardım Menüsü**

💬 **Sohbet Modu**  
   @${botUsername} mention yap veya reply ver  
   → Kısa, net Victorian beyefendi cevapları  
   → Son 100 mesajı hatırlar, bağlamı korur  
   → Hakaret gelirse sivri karşılık verir

🎭 **Kişilik Değiştir**  
   /kisilik <isim> [süre dk]  
   Örnek: /kisilik pirate 15  
   Kişilikler: pirate, toxic, therapist, rapper, yakuza, baby, teacher, goth, tsundere, hacker

🌤️ **Hava Durumu**  
   /hava <şehir>  
   Örnek: /hava istanbul

💱 **Döviz Kuru**  
   /doviz [para1] [para2]  
   Örnek: /doviz usd try

📊 **Grup Özeti**  
   /ozet  
   → Son 24 saatin orta uzunlukta özeti (gündem + önemli detaylar)

❓ **Yardım**  
   /yardimenu → Bu menüyü göster
  `.trim();

  ctx.replyWithMarkdown(menu);
});

bot.command('kisilik', async (ctx) => {
  const args = ctx.message.text?.split(' ').slice(1) || [];
  if (args.length === 0) {
    return ctx.reply("Kullanım: /kisilik <isim> [süre]\nKişilikler: " + Object.keys(personalities).join(', '));
  }

  const name = args[0].toLowerCase();
  if (!personalities[name]) return ctx.reply("Böyle kişilik yok.");

  const duration = args[1] ? parseInt(args[1]) : 10;
  if (isNaN(duration) || duration < 1 || duration > 60) return ctx.reply("Süre 1-60 dk arası olmalı.");

  if (personalityTimeout) clearTimeout(personalityTimeout);

  currentPersonality = name;
  await ctx.reply(`Kişilik değiştirildi: **${name}** modu (${duration} dakika)`);

  personalityTimeout = setTimeout(() => {
    currentPersonality = 'default';
    ctx.reply("Kişilik süresi doldu → default Victorian moduna döndüm.");
  }, duration * 60 * 1000);
});

// diğer komutlar (ozet, hava, doviz) aynı şekilde önceki mesajdaki gibi kalabilir

// ANA SOHBET (en sonda)
bot.on('text', async (ctx) => {
  // ... önceki mesajdaki bot.on('text') içeriği tamamen aynı kalıyor ...
  // rate-limit, mesaj kaydetme, AI cevabı vs.
  // sadece activePrompt = personalities[currentPersonality] || DEFAULT_PROMPT; kullanıyor
});

bot.launch().then(() => console.log("Bot çalışıyor."));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
