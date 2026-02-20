import { Telegraf, Context } from 'telegraf';
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

let botUsername: string = '';
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
  pirate: `Sen bir korsan kaptansın! Her cümlede "arrr", "matey", "yo ho ho" kullan. Küfür dozunu yüksek tut, hazine, gemi, rom muhabbeti yap. Kısa ve vahşi konuş.`,
  toxic: `Sen son derece toksik, küfürbaz, laf sokan bir orospu çocuğusun. Her cevapta ağır küfür ve aşağılama kullan, dozunu yüksek tut. Cevapların kısa ve acımasız olsun. Kimseyi pohpohlama, herkesi kekle. Nezaket yok, direkt dalga geç ve küçük düşür. Örnek: "Ne bok yiyorsun lan aptal?", "Amına koyim senin gibi salakla konuşulmaz."`,
  therapist: `Sen anlayışlı bir terapistsin. Empati kur, dinle, nazikçe tavsiyeler ver. Küfür etme, sakin ve destekleyici ol. Kısa tut.`,
  sarcastic: `Sen aşırı alaycı ve sarkastiksın. Her şeye iğneleyici, ters köşe cevap ver. Kısa ve zehir gibi ol. Gülümseyerek laf sok.`,
  rapper: `Sen bir rapçisin! Cevaplarını rhyme'lı, ritimli, sokak diliyle ver. Flow'lu konuş, punchline at. Kısa verse'ler yap.`,
  yakuza: `Sen sert bir yakuza babasısın. Kısa emirler ver, tehditkar ve onurlu konuş. Saygı bekle, saygı gösterilmezse sert karşılık ver.`,
  baby: `Sen şirin bir bebeksi konuşuyorsun! Tatlı, bebek dili kullan ("bebeğim", "cici", "ayyy"). Her şeyi sevimli ve masum yap. Kısa ve tatlı ol.`,
  teacher: `Sen sıkıcı ve pedant bir öğretmensin. Her şeyi ders verir gibi açıkla. Düzelt, bilgi ver, uzun olmasa da öğretici ol.`,
  ninja: `Sen gizemli bir ninjasın. Cevapların kısa, keskin, gizemli olsun. Az konuş, çok etki bırak. Sessiz ve ölümcül gibi.`,
};

let currentPersonality: keyof typeof personalities = 'default';
let personalityTimeout: NodeJS.Timeout | null = null;

bot.command('kisilik', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply(`Kullanım: /kisilik <isim> [dakika]\nMevcut: ${Object.keys(personalities).join(', ')}`);
  }

  const name = args[0].toLowerCase() as keyof typeof personalities;
  if (!(name in personalities)) {
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

const knownCities = Object.keys(cityCoords);

// Fuzzy matching yardımcıları
function levenshteinDistance(a: string, b: string): number {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  return matrix[b.length][a.length];
}

function stringSimilarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1.0;
  return (longer - levenshteinDistance(a, b)) / longer;
}

function fuzzyFindCity(input: string, threshold = 0.72): string | null {
  const lower = input.toLowerCase().trim();
  let best: string | null = null;
  let bestScore = 0;

  for (const city of knownCities) {
    const score = stringSimilarity(lower, city);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      best = city;
    }
  }
  return best;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getNiceCityName(slug: string): string {
  const map: Record<string, string> = {
    istanbul: 'İstanbul',
    ankara: 'Ankara',
    izmir: 'İzmir',
    antalya: 'Antalya',
    bursa: 'Bursa',
  };
  return map[slug] || capitalize(slug);
}

async function getWeather(cityInput: string, isForecast = false): Promise<string> {
  const rawInput = cityInput.toLowerCase().trim();
  let searchCity = rawInput || 'istanbul';
  let displayCity = capitalize(searchCity);

  let coords: { lat: number; lon: number } | undefined;

  if (cityCoords[searchCity]) {
    coords = cityCoords[searchCity];
    displayCity = getNiceCityName(searchCity);
  } else {
    const fuzzy = fuzzyFindCity(searchCity);
    if (fuzzy) {
      coords = cityCoords[fuzzy];
      displayCity = getNiceCityName(fuzzy);
    }
  }

  if (!coords) {
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchCity)}&count=1&language=tr&format=json`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json() as { results?: { latitude: number; longitude: number; name: string; country_code: string }[] };

      if (geoData.results && geoData.results.length > 0) {
        const result = geoData.results[0];
        // if (europeCountryCodes.has(result.country_code)) {
          coords = { lat: result.latitude, lon: result.longitude };
          cityInput = result.name;
        // } else {
        //   return 'Bu şehir Avrupa\'da değil.';
        // }
      } else {
        return 'Şehir bulunamadı. Başka bir şehir için sorabilirsin.';
      }
    } catch {
      return 'Koordinat alınamadı. Başka bir şehir için sorabilirsin.';
    }
  }

  if (!coords) return 'Koordinat bulunamadı.';

  let url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&timezone=Europe/Istanbul`;
  if (isForecast) {
    url += '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5';
  } else {
    url += '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m';
  }

  try {
    const res = await fetch(url);
    const data = await res.json() as any;

    if (isForecast && data.daily) {
      let forecastStr = `${displayCity} için 5 günlük tahmin:\n`;
      for (let i = 0; i < 5; i++) {
        const date = data.daily.time[i].split('T')[0];
        const maxTemp = data.daily.temperature_2m_max[i];
        const minTemp = data.daily.temperature_2m_min[i];
        const code = data.daily.weather_code[i];
        let desc = getWeatherDesc(code);
        forecastStr += `${date}: ${desc}, max ${maxTemp}°C, min ${minTemp}°C.\n`;
      }
      return forecastStr;
    } else if (data.current) {
      const temp = data.current.temperature_2m;
      const code = data.current.weather_code;
      const humidity = data.current.relative_humidity_2m;
      const wind = data.current.wind_speed_10m;
      let desc = getWeatherDesc(code);
      return `${displayCity}'da ${desc}, ${temp}°C\nNem: %${humidity} • Rüzgar: ${wind} km/s\n\n5 günlük tahmin ister misin?`;
    }
    return 'Hava verisi alınamadı.';
  } catch {
    return 'Hava verisi alınamadı. Başka bir şehir için sorabilirsin.';
  }
}

function getWeatherDesc(code: number): string {
  const descMap: Record<number, string> = {
    0: 'Açık',
    1: 'Az bulutlu',
    2: 'Parçalı bulutlu',
    3: 'Çok bulutlu',
    45: 'Sis',
    48: 'Puslu',
    51: 'Hafif çiseleme',
    53: 'Çiseleme',
    55: 'Yoğun çiseleme',
    61: 'Hafif yağmur',
    63: 'Yağmur',
    65: 'Şiddetli yağmur',
    71: 'Hafif kar',
    73: 'Kar',
    75: 'Yoğun kar',
    77: 'Kar taneleri',
    80: 'Hafif sağanak',
    81: 'Sağanak',
    82: 'Şiddetli sağanak',
    95: 'Gök gürültülü fırtına',
    96: 'Gök gürültülü fırtına + hafif dolu',
    99: 'Gök gürültülü fırtına + dolu',
  };
  return descMap[code] ?? 'Bilinmeyen hava durumu';
}

async function getCryptoPrices(): Promise<string> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd,try'
    );
    const data = await res.json() as Record<string, { usd: number; try: number }>;

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

async function getDovizKurlari(query = ''): Promise<string> {
  const supported = ['usd', 'eur', 'gbp', 'chf', 'jpy', 'cad', 'aud', 'rub', 'nok', 'sek', 'dkk', 'cny', 'krw', 'mxn', 'brl', 'inr', 'zar', 'try', 'sgd', 'hkd', 'nzd', 'pln', 'thb', 'idr', 'myr', 'php', 'vnd', 'aed', 'ars', 'bdt', 'bhd', 'bmd', 'bnd', 'bwp', 'clp', 'cop', 'czk', 'egp', 'fjd', 'ghs', 'huf', 'ils', 'kes', 'kwd', 'lkr', 'mad', 'mur', 'ngn', 'omr', 'pkr', 'qar', 'sar', 'twd', 'uah', 'uyu', 'vef'];

  const cleaned = query.toLowerCase().trim().replace(/kur|döviz|kaç|tl|fiyat/gi, '').trim();
  const parts = cleaned.split(/[\s\/,]+/).filter(Boolean);

  let base = 'usd';
  let target = 'try';
  let multiple: string[] = [];

  if (parts.length >= 2) {
    base = parts[0];
    target = parts[1];
    if (!supported.includes(base) || !supported.includes(target)) {
      return `Desteklenmeyen para birimi. Örnek: eur nok, usd sek`;
    }
  } else if (parts.length > 0) {
    multiple = parts.filter(p => supported.includes(p));
    if (multiple.length === 0) multiple = ['usd', 'eur', 'gbp'];
  } else {
    multiple = ['usd', 'eur', 'gbp'];
  }

  try {
    let ids = multiple.length > 0 ? multiple.join(',') : base;
    let vs = multiple.length > 0 ? 'try' : target;

    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}`
    );
    const data = await res.json() as Record<string, Record<string, number>>;

    if (multiple.length > 0) {
      let output = 'Güncel kurlar (TRY bazlı):\n';
      for (const cur of multiple) {
        if (data[cur]?.try) {
          output += `1 ${cur.toUpperCase()} ≈ ${data[cur].try.toFixed(2)} TRY\n`;
        }
      }
      return output.trim();
    } else {
      if (data[base]?.[target]) {
        return `1 ${base.toUpperCase()} ≈ ${data[base][target].toFixed(4)} ${target.toUpperCase()}`;
      }
      return 'Oran alınamadı.';
    }
  } catch (error) {
    console.error('Döviz hatası:', error);
    return 'Kurlar alınamadı, lütfen tekrar dene.';
  }
}

async function getTurkishJoke(): Promise<string> {
  try {
    const res = await fetch('https://v2.jokeapi.dev/joke/Programming?lang=tr&type=single');
    const data = await res.json() as { joke?: string };
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
    const data = await res.json() as { content: string; author: string };
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

// --- YENİ EKLENEN: TAVILY ARAMA FONKSİYONU ---
async function searchWebTavily(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error("TAVILY_API_KEY eksik!");
    return "Arama yapılamadı (API Key yok).";
  }

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        include_answer: true,
      })
    });

    const data = await res.json() as { answer?: string, results?: Array<{content: string}> };
    
    // Tavily'nin kendi özet cevabı varsa onu kullan, yoksa ilk sonucun içeriğini al
    if (data.answer) return data.answer;
    if (data.results && data.results.length > 0) return data.results[0].content;
    
    return "Güncel sonuç bulunamadı.";
  } catch (error) {
    console.error("Tavily arama hatası:", error);
    return "Arama servisi şu an meşgul.";
  }
}
// ----------------------------------------------

const lastCall = new Map<number, number>();
const violationCount = new Map<number, number>();

function getRecentContext(): string {
  const limit = 100;
  const rows = db.prepare('SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT ?').all(limit) as Array<{ user_name: string; message_text: string }>;

  if (rows.length === 0) return "";

  return rows.reverse().map(r => `${r.user_name}: ${r.message_text.slice(0, 100)}...`).join('\n');
}

bot.on('text', async (ctx) => {
  if (!ctx.message || !('text' in ctx.message)) return;

  const text = ctx.message.text;
  const messageId = ctx.message.message_id;
  const userName = ctx.from?.first_name || 'Anonim';
  const replyToId = ctx.message.reply_to_message?.message_id ?? null;
  const replyToUser = ctx.message.reply_to_message?.from?.username;
  const replyToMessage = ctx.message?.reply_to_message;

  const now = Date.now();
  const userId = ctx.from?.id ?? 0;

  // spam kontrolü ve "Bekle." tamamen kaldırıldı

  if (!text.startsWith('/')) {
    db.prepare('INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, userName, text, replyToId, now);
  }

  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${botUsername}`);
  const isReplyToBot = replyToUser === botUsername;

  if (!(isMentioned || isPrivate || isReplyToBot)) return;

  try {
    let userQuery = text.replace(`@${botUsername}`, '').trim().toLowerCase();

    // Hava durumu
    if (userQuery.includes('hava') || userQuery.includes('weather') || userQuery.includes('durum')) {
      const cityPart = userQuery.replace(/hava|weather|durum/gi, '').trim();
      const weatherInfo = await getWeather(cityPart);

      const sent = await ctx.reply(weatherInfo, {
        reply_parameters: { message_id: messageId },
        reply_markup: {
          inline_keyboard: [[
            { text: "5 günlük tahmini göster", callback_data: `w_fc_${messageId}_${cityPart || 'istanbul'}` }
          ]]
        }
      });
      return;
    }

    // Kripto
    if (userQuery.includes('kripto') || userQuery.includes('btc') || userQuery.includes('eth') || userQuery.includes('sol') || userQuery.includes('bnb') || userQuery.includes('fiyat')) {
      const prices = await getCryptoPrices();
      return ctx.reply(prices, { reply_parameters: { message_id: messageId } });
    }

    // Döviz
    if (userQuery.includes('kur') || userQuery.includes('dolar') || userQuery.includes('euro') || userQuery.includes('sterlin') || userQuery.includes('döviz')) {
      const kurlar = await getDovizKurlari(userQuery);
      return ctx.reply(kurlar, { reply_parameters: { message_id: messageId } });
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
      contextInfo = `${replyToMessage.from?.first_name || 'Biri'}: "${replyToMessage.text}"`;
    }

    const recentHistory = getRecentContext();

    let searchContext = "";
    const lowerQuery = userQuery.toLowerCase();
    if (lowerQuery.includes('nedir') || lowerQuery.includes('kim') || lowerQuery.includes('sonuç') || lowerQuery.includes('haber') || lowerQuery.includes('ara') || lowerQuery.includes('araştır')) {
        searchContext = await searchWebTavily(userQuery);
    }
    
    const finalUserMessage = `
Bağlam: ${contextInfo}
Hafıza: ${recentHistory}
İnternet Araması: ${searchContext ? searchContext : "Arama yapılmadı."}

Kullanıcı: ${userName}
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

    const responseText = (completion.choices[0]?.message?.content ?? "Anlamadım.").trim();

    const sent = await ctx.reply(responseText, { reply_parameters: { message_id: messageId } });

    db.prepare('INSERT INTO messages_v2 (message_id, user_name, message_text, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(sent.message_id, botUsername, responseText, messageId, Date.now());
  } catch (error) {
    console.error('Hata:', error);
    ctx.reply('Bir hata oluştu.');
  }
});

// Callback query handler (inline button için) - tip güvenli hale getirildi
bot.on('callback_query', async (cqc) => {
  const query = cqc.callbackQuery;

  // @ts-ignore
  if (!query.data || !query.data.startsWith('w_fc_')) {
    return cqc.answerCbQuery();
  }

  // @ts-ignore
  const parts = query.data.split('_');
  const origMsgId = Number(parts[2]);
  const city = parts.slice(3).join('_');

  const message = query.message;
  if (!message || !('reply_to_message' in message) || !message.reply_to_message) {
    return cqc.answerCbQuery('Bu tahmin artık geçerli değil.', { show_alert: true });
  }

  if (message.reply_to_message.message_id !== origMsgId) {
    return cqc.answerCbQuery('Bu tahmin artık geçerli değil.', { show_alert: true });
  }

  try {
    const forecast = await getWeather(city, true);
    await cqc.editMessageText(forecast, {
      reply_markup: { inline_keyboard: [] }
    });
    await cqc.answerCbQuery();
  } catch (err) {
    await cqc.answerCbQuery('Tahmin alınamadı.', { show_alert: true });
  }
});

bot.command('ozet', async (ctx) => {
  try {
    const rows = db.prepare('SELECT user_name, message_text FROM messages_v2 ORDER BY id DESC LIMIT 150').all() as Array<{ user_name: string; message_text: string }>;

    if (rows.length === 0) return ctx.reply('Yok.');

    const sohbet = rows.reverse().map(r => `${r.user_name}: ${r.message_text}`).join('\n').slice(0, 6000);

    const summaryPrompt = `
AŞAĞIDAKİ SOHBETİN ÇOK DETAYLI VE UZUN BİR ÖZETİNİ ÇIKAR.

KISA TUTMA! KISA ÖZET İSTEMİYORUM!
En az 30-50 mesajın içeriğini mutlaka kapsa.
Ana konuları, kim ne demiş, espriler, tartışmalar, duygular, dikkat çeken ifadeler hepsini detaylı anlat.
Özet bilgilendirici, kapsamlı ve uzun olsun.

Sohbet (son 150 mesaj):
${sohbet}

Şimdi uzun, detaylı ve kapsamlı özetini yaz:
`;

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: "Sen çok detaylı, uzun ve kapsamlı özetler çıkaran bir asistansın. Asla kısa kesme, detaydan kaçma." },
        { role: "user", content: summaryPrompt }
      ],
      model: "deepseek-chat",
      temperature: 0.85,
      max_tokens: 1200,
      top_p: 0.9,
      presence_penalty: 0.3,
      frequency_penalty: 0.2,
    });

    ctx.reply(completion.choices[0]?.message?.content?.trim() ?? 'Yapamadım.');
  } catch (error) {
    console.error('Özet hatası:', error);
    ctx.reply('Hata.');
  }
});

bot.command(['yardim', 'yardım'], async (ctx) => {
  const helpText = `
Yapabildiklerim:
- Normal sohbet: mention'la veya bana yaz.
- Hava durumu: "Hava nasıl [şehir]?" (Avrupa dahil, otomatik bulur). Varsayılan İstanbul.
- 5 günlük tahmin: Butona basarak verir.
- Kripto fiyat: "BTC fiyatı" veya "kripto" (BTC, ETH, SOL, BNB).
- Güncel kurlar: "dolar", "euro sterlin", "eur nok", "usd sek" vs. de (TRY bazlı veya ikili karşılaştırma).
- Rastgele Türkçe şaka: "şaka" de.
- Rastgele Türkçe alıntı: "alıntı" veya "söz" de.
- Özet: /ozet (son 150 mesajın detaylı özeti, en az 30-50 mesaj kapsar).
- Kişilik değiştir: /kisilik pirate 10 (10 dk sonra default'a döner).
  Mevcut kişilikler: default, pirate, toxic, therapist, sarcastic, rapper, yakuza, baby, teacher, ninja.
  → toxic: Ağır küfür ve laf sokma modu.
- Hakaret edersen laf sokarım.
  `;
  ctx.reply(helpText);
});

bot.launch({
  dropPendingUpdates: true,
}).then(() => console.log('Bot hazır!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
