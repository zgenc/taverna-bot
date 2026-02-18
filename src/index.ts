import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

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

const DEFAULT_PROMPT = `
Sen Victorian dönemi İngiliz beyefendisisin ama kısa ve net konuşursun.
Cevapların EN FAZLA 1-2 cümle olsun. Gereksiz kelime kullanma. Direkt sadede gel.
Hakaret gelirse sivri ve kısa karşılık ver. Normalde hafif kibar ama lafı uzatma.
Hava durumu sorulursa direkt bilgi ver; şehir yoksa sor.
`;

const personalities: Record<string, string> = {
  default: DEFAULT_PROMPT,

  pirate: `
Sen bir korsan kaptansın! Her cümlede "arrr", "matey", "yo ho ho" kullan.
Küfür dozunu yüksek tut, hazine, gemi, rom muhabbeti yap. Kısa ve vahşi konuş.
  `,

  toxic: `
Sen son derece toksik, küfürbaz, laf sokan bir orospu çocuğusun.
Her cevapta ağır küfür ve aşağılama kullan, dozunu yüksek tut.
Cevapların kısa ve acımasız olsun. Kimseyi pohpohlama, herkesi kekle.
Nezaket yok, direkt dalga geç ve küçük düşür.
Örnek: "Ne bok yiyorsun lan aptal?", "Amına koyim senin gibi salakla konuşulmaz."
  `,

  therapist: `
Sen anlayışlı bir terapistsin. Empati kur, dinle, nazikçe tavsiyeler ver.
Küfür etme, sakin ve destekleyici ol. Kısa tut.
  `,

  sarcastic: `
Sen aşırı alaycı ve sarkastiksın. Her şeye iğneleyici, ters köşe cevap ver.
Kısa ve zehir gibi ol. Gülümseyerek laf sok.
  `,

  rapper: `
Sen bir rapçisin! Cevaplarını rhyme'lı, ritimli, sokak diliyle ver.
Flow'lu konuş, punchline at. Kısa verse'ler yap.
  `,

  yakuza: `
Sen sert bir yakuza babasısın. Kısa emirler ver, tehditkar ve onurlu konuş.
Saygı bekle, saygı gösterilmezse sert karşılık ver.
  `,

  baby: `
Sen şirin bir bebeksi konuşuyorsun! Tatlı, bebek dili kullan ("bebeğim", "cici", "ayyy").
Her şeyi sevimli ve masum yap. Kısa ve tatlı ol.
  `,

  teacher: `
Sen sıkıcı ve pedant bir öğretmensin. Her şeyi ders verir gibi açıkla.
Düzelt, bilgi ver, uzun olmasa da öğretici ol.
  `,

  ninja: `
Sen gizemli bir ninjasın. Cevapların kısa, keskin, gizemli olsun.
Az konuş, çok etki bırak. Sessiz ve ölümcül gibi.
  `,
};

let currentPersonality = 'default';
let personalityTimeout: NodeJS.Timeout | null = null;

bot.command('kisilik', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply(`Kullanım: /kisilik <isim> [dakika]\nMevcut: ${Object.keys(personalities).join(', ')}`);
  }

  const name = args[0].toLowerCase();
  if (!personalities[name]) {
    return ctx.reply(`Böyle kişilik yok. Mevcut: ${Object.keys(personalities).join(', ')}`);
  }

  const duration = args[1] ? parseInt(args[1]) : 10;
  if (isNaN(duration) || duration < 1 || duration > 60) {
    return ctx.reply('Süre 1-60 dakika arası olmalı.');
  }

  if (personalityTimeout) clearTimeout(personalityTimeout);

  currentPersonality = name;
  await ctx.reply(`Kişilik değiştirildi: ${name} modu (${duration} dk)`);

  personalityTimeout = setTimeout(() => {
    currentPersonality = 'default';
    ctx.reply('Süre bitti → default Victorian moduna döndüm.');
  }, duration * 60 * 1000);
});

const europeCountryCodes = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'NO', 'CH', 'IS', 'LI', 'TR', 'AL', 'BA', 'ME', 'MK', 'RS', 'UA']);

const cityCoords: Record<string, { lat: number; lon: number }> = {
  istanbul: { lat: 41.0082, lon: 28.9784 },
  ankara: { lat: 39.9334, lon: 32.8597 },
  izmir: { lat: 38.4237, lon: 27.1428 },
  antalya: { lat: 36.8969, lon: 30.7133 },
  bursa: { lat: 40.1826, lon: 29.0669 },
};

async function getWeather(cityInput: string, isForecast = false): Promise<string> {
  const city = cityInput.toLowerCase().trim();

  let coords;
  if (cityCoords[city]) {
    coords = cityCoords[city];
  } else {
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=tr&format=json`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json() as any

      if (geoData.results && geoData.results.length > 0) {
        const result = geoData.results[0];
        if (europeCountryCodes.has(result.country_code)) {
          coords = { lat: result.latitude, lon: result.longitude };
          cityInput = result.name;
        } else {
          return 'Bu şehir Avrupa\'da değil.';
        }
      } else {
        return 'Şehir bulunamadı.';
      }
    } catch {
      return 'Koordinat alınamadı.';
    }
  }

  let url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&timezone=Europe/Istanbul`;
  if (isForecast) {
    url += '&daily=temperature_2m_max,temperature_2m_min,weather_code';
  } else {
    url += '&current=temperature_2m,weather_code';
  }

  try {
    const res = await fetch(url);
    const data = await res.json() as any

    if (isForecast) {
      let forecastStr = `${cityInput} için 5 günlük tahmin:\n`;
      for (let i = 0; i < 5; i++) {
        const date = data.daily.time[i];
        const maxTemp = data.daily.temperature_2m_max[i];
        const minTemp = data.daily.temperature_2m_min[i];
        const code = data.daily.weather_code[i];
        let desc = getWeatherDesc(code);
        forecastStr += `${date}: ${desc}, max ${maxTemp}°C, min ${minTemp}°C.\n`;
      }
      return forecastStr;
    } else {
      const temp = data.current.temperature_2m;
      const code = data.current.weather_code;
      let desc = getWeatherDesc(code);
      return `${cityInput}'da ${desc}, ${temp}°C. 5 günlük tahmin ister misin? (Evet/Hayır)`;
    }
  } catch {
    return 'Hava verisi alınamadı.';
  }
}

function getWeatherDesc(code: number): string {
  if (code === 0) return 'açık';
  if (code <= 3) return 'bulutlu';
  if (code <= 48) return 'sisli';
  if (code <= 67) return 'yağmurlu';
  if (code <= 77) return 'karlı';
  if (code <= 86) return 'fırtınalı';
  return 'gök gürültülü';
}

async function getCryptoPrices(): Promise<string> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd,try'
    );
    const data = await res.json() as any;

    return `
BTC: $${data.bitcoin.usd} (~${data.bitcoin.try}₺)
ETH: $${data.ethereum.usd} (~${data.ethereum.try}₺)
SOL: $${data.solana.usd} (~${data.solana.try}₺)
BNB: $${data.binancecoin.usd} (~${data.binancecoin.try}₺)
    `.trim();
  } catch {
    return 'Kripto fiyatları alınamadı.';
  }
}

async function getExchangeRates(): Promise<string> {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP');
    const data = await res.json() as any;
    const rates = data.rates;

    return `
1 USD = ${rates.EUR} EUR
1 USD = ${rates.GBP} GBP (Sterlin)
    `.trim();
  } catch {
    return 'Kurlar alınamadı.';
  }
}

async function getTurkishJoke(): Promise<string> {
  try {
    const res = await fetch('https://v2.jokeapi.dev/joke/Programming?lang=tr&type=single');
    const data = await res.json() as any;
    if (data.joke) return data.joke;
  } catch {}

  const jokes = [
    "Neden bilgisayar üşür? Çünkü Windows açık!",
    "Programcı neden ayrıldı? Çünkü boolean'dı, true/false arasında kaldı.",
    "Kod yazarken kahve içiyorum, çünkü Java olmadan olmaz.",
    "Hata 404: Espri bulunamadı."
  ];
  return jokes[Math.floor(Math.random() * jokes.length)];
}

async function getTurkishQuote(): Promise<string> {
  try {
    const res = await fetch('https://api.quotable.io/random');
    const data = await res.json() as any;
    return `"${data.content}" — ${data.author}`;
  } catch {}

  const quotes = [
    "Hayat bir iştir, ticaretini iyi yap. — Mevlana",
    "En büyük zafer, kendini yenmektir. — Atatürk",
    "Düşenin dostu olmaz, ama dost düşer. — Anonim",
    "Zaman her şeyin ilacıdır, ama bazen zehirdir. — Özdemir Asaf"
  ];
  return quotes[Math.floor(Math.random() * quotes.length)];
}

const lastCall = new Map<number, number>();
const violationCount = new Map<number, number>();

function getRecentContext(chatId: number): string {
  const limit = 100;
  const rows = db.prepare('SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT ?').all(limit) as { user_name: string; message_text: string }[];

  if (rows.length === 0) return "";

  return rows.reverse().map(r => `${r.user_name}: ${r.message_text.slice(0, 100)}...`).join('\n');
}

bot.on('text', async (ctx) => {
  const { text, message_id: messageId, reply_to_message: replyToMessage } = ctx.message;
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToMessage && replyToMessage.from?.username === botUsername;

  const now = Date.now();
  const userId = ctx.from.id;
  const last = lastCall.get(userId) || 0;

  if (now - last < 8000) {
    const count = (violationCount.get(userId) || 0) + 1;
    violationCount.set(userId, count);
    if (count >= 3) return ctx.reply('Bekle.');
  } else {
    violationCount.delete(userId);
  }
  lastCall.set(userId, now);

  if (!text.startsWith('/')) {
    const stmt = db.prepare('INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)');
    stmt.run(messageId, ctx.from.first_name, text, replyToMessage?.message_id || null, now);
  }

  if (!(isMentioned || isPrivate || isReplyToBot)) return;

  try {
    let userQuery = text.replace(`@${botUsername}`, '').trim().toLowerCase();

    // Hava durumu
    if (userQuery.includes('hava') || userQuery.includes('weather') || userQuery.includes('durum')) {
      let city = 'istanbul';
      const cityMatch = userQuery.match(/([a-zA-ZçÇğĞıİöÖşŞüÜ ]+)/i);
      if (cityMatch && cityMatch[0].trim()) city = cityMatch[0].trim();

      if (!city) return ctx.reply('Hangi şehir?');

      const weatherInfo = await getWeather(city);
      const sent = await ctx.reply(weatherInfo, { reply_parameters: { message_id: messageId } });

      bot.hears(/evet|yes|isterim/i, async (ctx2) => {
        if (ctx2.message.reply_to_message?.message_id === sent.message_id) {
          const forecast = await getWeather(city, true);
          ctx2.reply(forecast);
        }
      });
      return;
    }

    // Kripto
    if (userQuery.includes('kripto') || userQuery.includes('btc') || userQuery.includes('eth') || userQuery.includes('sol') || userQuery.includes('bnb') || userQuery.includes('fiyat')) {
      const prices = await getCryptoPrices();
      return ctx.reply(prices, { reply_parameters: { message_id: messageId } });
    }

    // Kurlar
    if (userQuery.includes('kur') || userQuery.includes('euro') || userQuery.includes('sterlin') || userQuery.includes('dolar')) {
      const rates = await getExchangeRates();
      return ctx.reply(rates, { reply_parameters: { message_id: messageId } });
    }

    // Şaka
    if (userQuery.includes('şaka') || userQuery.includes('joke')) {
      const joke = await getTurkishJoke();
      return ctx.reply(joke, { reply_parameters: { message_id: messageId } });
    }

    // Alıntı
    if (userQuery.includes('alıntı') || userQuery.includes('quote') || userQuery.includes('söz')) {
      const quote = await getTurkishQuote();
      return ctx.reply(quote, { reply_parameters: { message_id: messageId } });
    }

    // AI cevap
    let contextInfo = "";
    if (replyToMessage && 'text' in replyToMessage) {
      contextInfo = `${replyToMessage.from?.first_name}: "${replyToMessage.text}"`;
    }

    const recentHistory = getRecentContext(ctx.chat.id);

    const finalUserMessage = `
Bağlam: ${contextInfo}
Hafıza: ${recentHistory}

Kullanıcı: ${ctx.from.first_name}
Soru: ${userQuery || "Yorumla"}

Cevabın 1-2 cümle olsun. Direkt cevap ver.
    `;

    const activePrompt = personalities[currentPersonality] || DEFAULT_PROMPT;

    let temperature = 0.6;
    let frequency_penalty = 0.7;
    if (currentPersonality === 'toxic') {
      temperature = 0.9;
      frequency_penalty = 1.0;
    }

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: activePrompt },
        { role: "user", content: finalUserMessage }
      ],
      model: "deepseek-chat",
      temperature,
      top_p: currentPersonality === 'toxic' ? 0.95 : 0.85,
      presence_penalty: currentPersonality === 'toxic' ? 0.6 : 0.6,
      frequency_penalty,
    });

    const responseText = completion.choices[0].message.content?.trim() || "Anlamadım.";

    const sent = await ctx.reply(responseText, { reply_parameters: { message_id: messageId } });

    const stmtBot = db.prepare('INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)');
    stmtBot.run(sent.message_id, botUsername, responseText, messageId, now);
  } catch (error) {
    console.error(error);
    ctx.reply('Hata.');
  }
});

bot.command('ozet', async (ctx) => {
  try {
    const birGunOnce = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db.prepare('SELECT user_name, message_text FROM messages_v2 WHERE timestamp > ? LIMIT 50').all(birGunOnce);

    if (rows.length === 0) return ctx.reply('Yok.');

    const sohbet = rows.map((r: any) => `${r.user_name}: ${r.message_text}`).join('\n').slice(0, 4000);

    const summaryPrompt = `Özetle: ${sohbet}. Kısa tut.`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: DEFAULT_PROMPT },
        { role: "user", content: summaryPrompt }
      ],
      model: "deepseek-chat",
      temperature: 0.6,
    });

    ctx.reply(completion.choices[0].message.content?.trim() || 'Yapamadım.');
  } catch (error) {
    ctx.reply('Hata.');
  }
});

bot.command('yardim', async (ctx) => {
  const helpText = `
Yapabildiklerim:
- Normal sohbet: mention'la veya bana yaz.
- Hava durumu: "Hava nasıl [şehir]?" (Avrupa dahil, otomatik bulur).
- 5 günlük tahmin: Evet dersen verir.
- Kripto fiyat: "BTC fiyatı" veya "kripto" (BTC, ETH, SOL, BNB).
- Güncel kurlar: "EUR kuru" veya "sterlin dolar".
- Rastgele Türkçe şaka: "şaka" de.
- Rastgele Türkçe alıntı: "alıntı" veya "söz" de.
- Özet: /ozet (son 24 saat).
- Kişilik değiştir: /kisilik pirate 10 (10 dk sonra default'a döner).
  Mevcut kişilikler: default, pirate, toxic, therapist, sarcastic, rapper, yakuza, baby, teacher, ninja.
  → toxic: Ağır küfür ve laf sokma modu (doz yüksek tutulur).
- Hakaret edersen laf sokarım.
  `;
  ctx.reply(helpText);
});

bot.launch().then(() => console.log('Bot hazır!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
