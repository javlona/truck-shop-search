/* Telegram Service Shop Bot
 * Node.js with node-telegram-bot-api and PostgreSQL
 * Features:
 *  - Add service shops (admin only)
 *  - Search shops by zip with radius & type filter
 *  - Error handling
 *  - Caches zip->coords
 *  - Uses axios for geocoding
 *
 * NOTE: Database schema is managed separately in `schema.sql`. Apply it via:
 *   psql $DATABASE_URL -f schema.sql
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('pg');
const axios = require('axios');

// Environment variables
const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const DATABASE_URL = process.env.DATABASE_URL;
const GEOCODER_API_KEY = process.env.GEOCODER_API_KEY;

// Initialize Telegram bot
const bot = new TelegramBot(TOKEN, { polling: true });

// Initialize PostgreSQL client
const db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => { await db.connect(); })();

// In-memory user state tracking
const userStates = {};

// Haversine formula for distance in miles
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const toRad = a => (a * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// /start command
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    `Welcome!\nUse /addshop to register a service shop (admin only).\nUse /findshops to search shops by ZIP code.`
  );
});

// Check if user is admin
const isAdmin = id => ADMIN_IDS.includes(String(id));

// /addshop flow
bot.onText(/\/addshop/, msg => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, 'Unauthorized: only admins can add shops.');
  }
  userStates[chatId] = { action: 'add', step: 'name', data: {} };
  bot.sendMessage(chatId, 'Enter shop name:');
});

// /findshops flow
bot.onText(/\/findshops/, msg => {
  const chatId = msg.chat.id;
  userStates[chatId] = { action: 'find', step: 'zip', data: {} };
  bot.sendMessage(chatId, 'Enter a US ZIP code:');
});

// Main message handler
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const state = userStates[chatId];
  if (!state) return;

  try {
    if (state.action === 'add') {
      const { data, step } = state;
      if (step === 'name') {
        data.name = msg.text;
        state.step = 'street';
        return bot.sendMessage(chatId, 'Enter street address:');
      }
      if (step === 'street') {
        data.street = msg.text;
        state.step = 'city';
        return bot.sendMessage(chatId, 'Enter city:');
      }
      if (step === 'city') {
        data.city = msg.text;
        state.step = 'state';
        return bot.sendMessage(chatId, 'Enter state:');
      }
      if (step === 'state') {
        data.state = msg.text;
        state.step = 'zip';
        return bot.sendMessage(chatId, 'Enter ZIP code:');
      }
      if (step === 'zip') {
        data.zip = msg.text;
        const coord = await getOrCacheCoords(data.zip);
        if (!coord) {
          delete userStates[chatId];
          return bot.sendMessage(chatId, 'Invalid ZIP code. Operation canceled.');
        }
        data.lat = coord.lat;
        data.lon = coord.lon;
        state.step = 'type';
        return bot.sendMessage(chatId, 'Enter service type (tire shop, body shop, truck repair, towing, roadside):');
      }
      if (step === 'type') {
        data.type = msg.text.toLowerCase();
        await db.query(
          'INSERT INTO shops(name, street, city, state, zip, type, lat, lon) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [data.name, data.street, data.city, data.state, data.zip, data.type, data.lat, data.lon]
        );
        delete userStates[chatId];
        return bot.sendMessage(chatId, 'Shop added successfully!');
      }
    }

    if (state.action === 'find') {
      const { data, step } = state;
      if (step === 'zip') {
        data.zip = msg.text;
        const coord = await getOrCacheCoords(data.zip);
        if (!coord) {
          delete userStates[chatId];
          return bot.sendMessage(chatId, 'Invalid ZIP code. Operation canceled.');
        }
        data.lat = coord.lat;
        data.lon = coord.lon;
        state.step = 'radius';
        return bot.sendMessage(chatId, 'Select radius (25, 50, or 150 miles):', {
          reply_markup: { keyboard: [['25'], ['50'], ['150']], one_time_keyboard: true }
        });
      }
      if (step === 'radius') {
        data.radius = parseInt(msg.text);
        state.step = 'type';
        return bot.sendMessage(chatId, 'Select service type:', {
          reply_markup: { keyboard: [['tire shop'], ['body shop'], ['truck repair'], ['towing'], ['roadside']], one_time_keyboard: true }
        });
      }
      if (step === 'type') {
        data.type = msg.text.toLowerCase();
        const res = await db.query('SELECT * FROM shops WHERE type=$1', [data.type]);
        const results = res.rows
          .map(s => ({ s, dist: getDistance(data.lat, data.lon, s.lat, s.lon) }))
          .filter(r => r.dist <= data.radius)
          .sort((a,b) => a.dist - b.dist);

        if (!results.length) {
          delete userStates[chatId];
          return bot.sendMessage(chatId, `No shops found within ${data.radius} miles.`);
        }

        const text = results.slice(0,5).map((r,i) =>
          `${i+1}. *${r.s.name}* - ${r.s.street}, ${r.s.city} (${r.dist.toFixed(1)} mi)`
        ).join('\n');

        delete userStates[chatId];
        return bot.sendMessage(chatId,
          `🔧 *${data.type.charAt(0).toUpperCase()+data.type.slice(1)}s near ${data.zip} (${data.radius}mi):*\n${text}`,
          { parse_mode: 'Markdown' }
        );
      }
    }

  } catch (err) {
    console.error(err);
    delete userStates[chatId];
    bot.sendMessage(chatId, 'Sorry, an error occurred. Please try again later.');
  }
});

// Geocode ZIP or return cached coords
async function getOrCacheCoords(zip) {
  const cacheRes = await db.query('SELECT lat, lon FROM zips WHERE zip=$1', [zip]);
  if (cacheRes.rows.length) return cacheRes.rows[0];

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${GEOCODER_API_KEY}`;
    const { data } = await axios.get(url);
    if (data.status !== 'OK' || !data.results.length) return null;
    const loc = data.results[0].geometry.location;
    await db.query('INSERT INTO zips(zip, lat, lon) VALUES($1,$2,$3)', [zip, loc.lat, loc.lng]);
    return { lat: loc.lat, lon: loc.lng };
  } catch {
    return null;
  }
}

// Graceful shutdown
process.on('SIGINT', async () => { await db.end(); process.exit(); });
