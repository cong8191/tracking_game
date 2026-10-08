import 'dotenv/config';
import express from 'express';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import axios from 'axios';
import cors from 'cors';
import multer from 'multer';
import pg from 'pg';
import FormData from 'form-data';
import * as cheerio from 'cheerio';

// Enable ESM compatibility helpers
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Kích hoạt plugin dayjs
dayjs.extend(customParseFormat);

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// --- KẾT NỐI POSTGRES ---
const { Pool } = pg;
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20,
});

db.connect()
  .then(client => {
    console.log('✅ Đã kết nối PostgreSQL thành công!');
    client.release();
  })
  .catch(err => {
    console.error('❌ Lỗi kết nối Database:', err.message);
  });

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbwzIlzn5gfKE38-mAGx1W7VCPfCu78nYDEnPmb6aUPVRl_dWALFthGYHFYbCSqyB0WLYw/exec";
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- TABLE ROW PARSERS ---
function parseCndTableRows(html) {
  const rows = [];
  if (!html || typeof html !== 'string') return rows;

  const trMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
  if (!trMatches) return rows;

  for (let i = 0; i < trMatches.length; i++) {
    const tr = trMatches[i];
    const tdMatches = tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi);
    if (tdMatches && tdMatches.length >= 6) {
      const col0 = tdMatches[0].replace(/<[^>]+>/g, '').trim();
      const col1 = tdMatches[1].replace(/<[^>]+>/g, '').trim();
      const col4 = tdMatches[4].replace(/<[^>]+>/g, '').trim();
      const col5 = tdMatches[5].replace(/<[^>]+>/g, '').trim();

      rows.push({ col0, col1, col4, col5 });
    }
  }
  return rows;
}

function parseSearchGalleryRows(html, searchKeyword) {
  const matched = [];
  if (!html || typeof html !== 'string') return matched;

  const trMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
  if (!trMatches) return matched;

  const kw = (searchKeyword || '').toLowerCase().trim();

  for (let i = 0; i < trMatches.length; i++) {
    const tr = trMatches[i];
    const tdMatches = tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi);
    if (tdMatches && tdMatches.length >= 3) {
      const col0Text = tdMatches[0].replace(/<[^>]+>/g, '').trim();
      const col2Text = tdMatches[2].replace(/<[^>]+>/g, '').trim();

      const hrefMatch = tdMatches[0].match(/href=["']([^"']+)["']/i) || tr.match(/href=["']([^"']+)["']/i);
      const href = hrefMatch ? hrefMatch[1] : '';

      if (!kw || col0Text.toLowerCase().includes(kw) || col2Text.toLowerCase().includes(kw)) {
        matched.push({
          title: col0Text,
          href: href,
          sub: col2Text
        });
      }
    }
  }
  return matched;
}

// --- LIQUID & GRIT REQUEST UTILITIES ---
function getLgHeaders(cookies, customHeaders = {}) {
  let cleanCookies = '';
  if (typeof cookies === 'string') {
    cleanCookies = cookies.replace(/[\r\n]+/g, '').trim();
  } else if (cookies && typeof cookies === 'object') {
    cleanCookies = (cookies.cookies || cookies.cookie || '').toString().replace(/[\r\n]+/g, '').trim();
  }

  const finalHeaders = {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  if (customHeaders) {
    Object.assign(finalHeaders, customHeaders);
  }

  if (cleanCookies && !finalHeaders['Cookie'] && !finalHeaders['cookie']) {
    finalHeaders['Cookie'] = cleanCookies;
  }

  return finalHeaders;
}

async function fetchLg(url, options = {}, cookies = '', retries = 2) {
  let cleanCookies = '';
  if (typeof cookies === 'string') {
    cleanCookies = cookies.replace(/[\r\n]+/g, '').trim();
  } else if (cookies && typeof cookies === 'object') {
    cleanCookies = (cookies.cookies || cookies.cookie || '').toString().replace(/[\r\n]+/g, '').trim();
  }

  const method = (options.method || 'POST').toLowerCase();
  const headers = {
    'User-Agent': BROWSER_USER_AGENT
  };

  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  if (cleanCookies) {
    headers['Cookie'] = cleanCookies;
  }

  const RETRIABLE_CODES = [460, 520, 521, 502, 503, 504];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const axiosConfig = {
        url,
        method,
        headers,
        data: options.body || options.data,
        responseType: 'text',
        validateStatus: () => true
      };

      if (options.body && typeof options.body.getHeaders === 'function') {
        Object.assign(headers, options.body.getHeaders());
      }

      const res = await axios(axiosConfig);

      if (RETRIABLE_CODES.includes(res.status) && attempt < retries) {
        console.warn(`⚠️ LiquidAndGrit HTTP ${res.status} on attempt ${attempt + 1}. Retrying in 400ms...`);
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }

      const resDataText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: res.headers,
        text: async () => resDataText,
        json: async () => typeof res.data === 'string' ? JSON.parse(res.data) : res.data,
        data: res.data
      };
    } catch (err) {
      if (attempt < retries) {
        console.warn(`⚠️ LiquidAndGrit network error on attempt ${attempt + 1}: ${err.message}. Retrying in 400ms...`);
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function fetchLgJson(url, options = {}, cookies = '', retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchLg(url, options, cookies, 0);
      const text = await response.text();

      if ([460, 520, 521, 502, 503, 504].includes(response.status) || text.includes('error code: 521') || text.includes('502 Bad Gateway') || text.includes('503 Service Unavailable')) {
        if (attempt < retries) {
          console.warn(`⚠️ Upstream error (HTTP ${response.status}) on attempt ${attempt + 1}. Retrying in 400ms...`);
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        throw new Error(`Server Liquid&Grit tạm thời bận (HTTP ${response.status}). Vui lòng thử lại.`);
      }

      try {
        return JSON.parse(text);
      } catch (parseErr) {
        if (attempt < retries) {
          console.warn(`⚠️ Non-JSON response on attempt ${attempt + 1}. Retrying in 400ms...`);
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        if (response.ok) return { message: text };
        throw new Error(`Server Liquid&Grit trả về dữ liệu không hợp lệ (HTTP ${response.status}): ${text.slice(0, 150)}`);
      }
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// --- COOKIE STORAGE (MEMORY + DB + FILE FALLBACK) ---
let memoryCookies = null;

async function ensureSettingsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT
      )
    `);
  } catch (err) {
    console.error('Error creating system_settings table:', err.message);
  }
}

async function getStoredCookies() {
  // 1. FAST PATH: RAM Memory Cache
  if (memoryCookies && Object.keys(memoryCookies).length > 0) {
    return memoryCookies;
  }

  // 2. Try file fallback if file exists (local development)
  try {
    if (fs.existsSync('cookies.json')) {
      const dataStr = fs.readFileSync('cookies.json', 'utf-8');
      if (dataStr) {
        memoryCookies = JSON.parse(dataStr);
        return memoryCookies;
      }
    }
  } catch (e) {}

  // 3. PostgreSQL Database
  try {
    await ensureSettingsTable();
    const res = await db.query("SELECT value FROM system_settings WHERE key = 'login_cookies'");
    if (res.rows[0]?.value) {
      const parsed = JSON.parse(res.rows[0].value);
      memoryCookies = parsed;
      return parsed;
    }
  } catch (err) {
    console.error('DB cookie get error:', err.message);
  }

  return memoryCookies || {};
}

async function saveStoredCookies(dataStr) {
  const parsed = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
  const jsonString = JSON.stringify(parsed);
  memoryCookies = parsed;

  // 1. File write (ignore if read-only filesystem like Deno Deploy)
  try {
    fs.writeFileSync('cookies.json', jsonString);
  } catch (e) {}

  // 2. Database save
  try {
    await ensureSettingsTable();
    await db.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('login_cookies', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [jsonString]);
  } catch (err) {
    console.error('DB cookie save error:', err.message);
  }
}

// --- GAME & EVENT CACHE HELPERS ---
const gameCache = new Map();
async function getGameByIdAsync(gameId) {
  if (gameCache.has(gameId)) return gameCache.get(gameId);
  const resDb = await db.query("SELECT * from games WHERE id = $1", [gameId]);
  if (!resDb.rows[0]) return null;
  const row = resDb.rows[0];
  const result = {
    ...row,
    tagId: row.tagId || row.tagid
  };
  gameCache.set(gameId, result);
  return result;
}

async function getEventByIdAsync(id) {
  const resDb = await db.query(
    'SELECT event.*, games.name as "gameName" FROM event inner join games on event.gameid = games.id WHERE event.id = $1',
    [id]
  );
  if (!resDb.rows[0]) return null;
  const row = resDb.rows[0];
  return {
    event_id: row.id,
    name: row.name,
    gallery_id: row.gallery_id,
    g_name: row.g_name,
    game_name: row.gameName
  };
}

const calculateDateRange = (dateRangeStr) => {
  if (!dateRangeStr || typeof dateRangeStr !== 'string' || !dateRangeStr.trim()) {
    return null;
  }

  const currentYear = dayjs().year();
  const currentMonth = dayjs().month() + 1;

  const parts = dateRangeStr.split('-').map(str => str.trim());
  let startStr = '', endStr = '';

  if (parts.length === 1) {
    startStr = parts[0];
    endStr = parts[0];
  } else if (parts.length === 2) {
    startStr = parts[0];
    endStr = parts[1];
  } else {
    return { startDate: null, endDate: null };
  }

  let endDay, endMonth, endYear = currentYear;
  if (endStr.includes('/')) {
    const splitEnd = endStr.split('/');
    endDay = parseInt(splitEnd[1]);
    endMonth = parseInt(splitEnd[0]);
  } else {
    endDay = parseInt(endStr);
    endMonth = currentMonth;
  }

  let startDay, startMonth = currentMonth, startYear = currentYear;
  if (startStr.includes('/')) {
    const splitStart = startStr.split('/');
    startDay = parseInt(splitStart[1]);
    startMonth = parseInt(splitStart[0]);
  } else {
    startDay = parseInt(startStr);
  }

  if (startMonth === 12 && endMonth === 1) {
    endYear = startYear + 1;
  }

  return {
    startDate: dayjs(`${startYear}-${startMonth}-${startDay}`, 'YYYY-M-D'),
    endDate: dayjs(`${endYear}-${endMonth}-${endDay}`, 'YYYY-M-D')
  };
};

const parseTrackerItem = (logString) => {
  if (!logString || typeof logString !== 'string') return null;

  const parts = logString.split('|');
  let contentPart = parts[0].trim();
  let urlPart = parts[1] ? parts[1].trim() : null;

  const prefixMatch = contentPart.match(/(?:for|gallery)\s+/);
  if (!prefixMatch) return null;

  const specialCharsRegex = /[\p{So}\p{Cf}]/gu;
  let mainString = contentPart.substring(prefixMatch.index + prefixMatch[0].length).trim();
  mainString = mainString.replace(/"/g, '').replace(specialCharsRegex, '').trim();

  const dateRegex = /\(([^)]+)\)$/;
  const dateMatch = mainString.match(dateRegex);

  let rawDate = '';
  let dates = {};
  let remaining = '';
  if (dateMatch) {
    rawDate = dateMatch[1].trim();
    dates = calculateDateRange(rawDate) || {};
    remaining = mainString.substring(0, dateMatch.index).trim();
  }

  const subEventRegex = /\(([^)]+)\)$/;
  const subMatch = remaining.match(subEventRegex);

  let eventName = "";
  let subEvent = "";

  if (subMatch) {
    subEvent = subMatch[1].trim();
    eventName = remaining.substring(0, subMatch.index).trim();
  } else {
    eventName = remaining === '' ? mainString : remaining;
    subEvent = "";
  }

  return {
    eventName,
    subEvent,
    url: urlPart,
    originalDate: rawDate,
    startDateObj: dates.startDate,
    endDateObj: dates.endDate
  };
};

const fetchGalleryInfo = async (galleryName, gameId, gameName = '', retList = false) => {
  const datas = await getStoredCookies();
  if (!datas || Object.keys(datas).length === 0) {
    return retList ? [] : {};
  }

  const game = await getGameByIdAsync(gameId);
  const tagId = game ? (game.tagId || game.tagid) : '';

  const obj = JSON.parse('{"limit": 500, "init": 0, "page": 0, "type": [], "status": [], "category": [], "non_category": [], "tag37": [], "tag38": [], "tag28": [], "tag34": [], "tag18": ["768367"], "tag35": [], "tag21": [], "tag29": [], "tag36": [], "tag22": [], "tag26": [], "tag45": [], "tag42": [], "tag9": [], "tag32": [], "tag4": [], "tag1": [], "tag2": [], "tag3": [], "tag10": [], "tag12": [], "tag7": [], "tag8": [], "tag11": [], "tag43": [], "tag13": [], "search": ""}');
  obj.tag18 = [tagId.toString()];
  obj.search = galleryName;

  const form = new FormData();
  form.append('csrf', datas.csrf);
  form.append('id', '1');
  form.append('vo-action', '');
  form.append('filter_conditions', JSON.stringify(obj));

  const responseData = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cms/blog/post-cnd', {
    method: 'POST',
    body: form
  }, datas.cookies);

  const contentList = responseData && responseData.content ? responseData.content : [];

  if (!retList) {
    const foundItem = contentList.find(item => item.name.toLowerCase() === galleryName.toLowerCase());
    return foundItem || {};
  }

  return contentList.filter(item => `${galleryName} - ${gameName}`.toLowerCase().includes(item.name.toLowerCase()));
};

const galleryInfoCache = new Map();
const fetchGalleryInfoCached = async (galleryName, gameId, gameName = '', retList = false) => {
  const cacheKey = `${galleryName}_${gameId}_${gameName}_${retList}`;
  if (galleryInfoCache.has(cacheKey)) return galleryInfoCache.get(cacheKey);
  const res = await fetchGalleryInfo(galleryName, gameId, gameName, retList);
  galleryInfoCache.set(cacheKey, res);
  return res;
};

// --- UPLOAD CONFIG ---
const uploadDir = path.join(__dirname, 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (e) {}

const uploadStorage = fs.existsSync(uploadDir) ? uploadDir : os.tmpdir();
const upload2 = multer({ dest: uploadStorage });

const storageSqlite = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.resolve(__dirname));
  },
  filename: (req, file, cb) => {
    cb(null, 'sample_game_db.sqlite');
  }
});
const uploadSqlite = multer({ storage: storageSqlite });

// ==========================================
//                   ROUTES
// ==========================================

// POST /saveLoginData
app.post('/saveLoginData', async (req, res) => {
  try {
    const { datas } = req.body;
    await saveStoredCookies(datas);
    res.json({ success: true });
  } catch (error) {
    console.error('Login failed:', error);
    res.json({ success: false, message: error.message });
  }
});

// GET /readDataCookies
app.get('/readDataCookies', async (req, res) => {
  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('vo-action', 'get_unread_count');

    try {
      const data = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cmn/inbox-cnd', {
        method: 'POST',
        body: form
      }, datas.cookies);

      if (data && data.error_message && data.error_message.length > 0) {
        console.warn("⚠️ Token hết hạn từ Liquid&Grit:", data.error_message);
        return res.json({ success: true, result: '', expired: true, message: data.error_message[0] });
      }

      return res.json({ success: true, result: JSON.stringify(datas), data });
    } catch (apiErr) {
      console.warn("⚠️ Không thể kiểm tra cookie với Liquid&Grit:", apiErr.message);
      return res.json({ success: true, result: JSON.stringify(datas), warning: apiErr.message });
    }
  } catch (err) {
    console.error("❌ loi doc data cookie:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /games?date=YYYY-MM-DD
app.get('/games', async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Missing date parameter' });

  try {
    const sql = `
      SELECT 
          g.id AS game_id,
          g.name AS game_name,
          e.id AS event_id,
          e.name AS event_name,
          e.gallery_id,
          e.default_day,
          e.g_name,
          e.post_slug
      FROM games g
      LEFT JOIN event e ON g.id = e.gameid
      AND COALESCE(e."IsContent", false) <> true
      ORDER BY g.id, e.id
    `;

    const sqlAction = `
      SELECT 
          a.id AS action_id,
          a.eventid,
          a.status,
          a."date",
          a."from",
          a."to",
          a."type"
      FROM action a
      WHERE a.date = $1 
    `;

    const resDb = await db.query(sql, []);
    const resAction = await db.query(sqlAction, [date]);

    const rows = resDb.rows;
    const actions = resAction.rows;
    const result = {};

    for (const row of rows) {
      const gameId = row.game_id;
      if (!result[gameId]) {
        result[gameId] = {
          id: gameId,
          name: row.game_name,
          events: [],
          "event-details": []
        };
      }

      if (row.event_id) {
        result[gameId].events.push({
          id: row.event_id,
          name: row.event_name,
          gallery_id: row.gallery_id,
          default_day: row.default_day,
          g_name: row.g_name,
          post_slug: row.post_slug || ''
        });
      }
    }

    for (const action of actions) {
      const game = Object.values(result).find(g =>
        g.events.some(ev => ev.id === action.eventid)
      );

      if (game) {
        game["event-details"].push({
          id: action.action_id,
          event_id: action.eventid,
          status: action.status,
          from: action.from || "",
          to: action.to || "",
          date: action.date,
          type: action.type
        });
      }
    }

    res.json(Object.values(result));
  } catch (err) {
    console.error("❌ Error in /games:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /delete_file
app.post('/delete_file', async (req, res) => {
  const { gallery_id, file } = req.body;

  if (!gallery_id || !file) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: name, gallery_id là bắt buộc.' });
  }

  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('vo-action', 'delete_file');
    form.append('type', '2');
    form.append('id', gallery_id);
    form.append('file', JSON.stringify(file));

    await fetchLg('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      body: form
    }, datas.cookies);

    res.json({ success: true, result: "OK" });
  } catch (error) {
    console.error("❌ Error in /delete_file:", error.message);
    res.status(500).send('loi khi xóa file.');
  }
});

// POST /getInfo
app.post('/getInfo', async (req, res) => {
  const { event_id } = req.body;

  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('id', event_id);

    const data = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      body: form
    }, datas.cookies);

    res.json({ success: true, result: data });
  } catch (err) {
    console.error("❌ Error in /getInfo:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload
app.post('/upload', upload2.single('file'), async (req, res) => {
  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Missing file' });
    }

    const customerFilename = req.body.customFilename || '';
    const isLastChunk = req.body.isLastChunk === true || req.body.isLastChunk === 'true' || req.body.isLastChunk === '1' || req.body.isLastChunk === 1;
    const needUpdateFileName = customerFilename.includes('/') && isLastChunk;

    const form = new FormData();
    for (const [key, value] of Object.entries(req.body)) {
      if (key === 'file') continue;
      if (key === 'flowFilename' && !customerFilename.includes('/')) {
        form.append(key, customerFilename);
      } else {
        form.append(key, value);
      }
    }

    const fileStream = fs.createReadStream(req.file.path);
    form.append('file', fileStream, req.file.originalname);

    let response = await axios.post(
      'https://my.liquidandgrit.com/action/admin/cms/file-upload-v3',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Cookie: datas.cookies,
          'User-Agent': BROWSER_USER_AGENT
        }
      }
    );

    if (fileStream) {
      fileStream.destroy();
    }
    fs.unlink(req.file.path, (err) => {
      if (err) console.error(`Không thể xóa file tạm: ${req.file.path}`, err);
    });

    if (needUpdateFileName) {
      response.data.file.name = customerFilename;
      response.data.file.order_index = req.body.order_index;
      response.data.file.type = '1';

      const form2 = new FormData();
      form2.append('csrf', datas.csrf);
      form2.append('vo-action', 'save_file');
      form2.append('type', '2');
      form2.append('id', req.body.id);
      form2.append('file', JSON.stringify(response.data.file));

      await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', form2, {
        headers: {
          ...form2.getHeaders(),
          Cookie: datas.cookies,
          'User-Agent': BROWSER_USER_AGENT
        }
      });
    }

    res.json({ success: true, result: "OK" });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).send('Proxy error while uploading.');
  }
});

// POST /upload-sqlite
app.post('/upload-sqlite', uploadSqlite.single('sqlite_file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }
  console.log('Đã ghi đè file sqlite:', req.file.path);
  res.status(200).send('Upload thành công');
});

// GET /template-sqlite.db
app.get('/template-sqlite.db', (req, res, next) => {
  const filePath = path.resolve(__dirname, 'sample_game_db.sqlite');
  res.download(filePath, 'template-sqlite.db', (err) => {
    if (err && err.code === 'ENOENT') return res.status(404).send('Không tìm thấy file mẫu');
    if (err) return next(err);
  });
});

// GET /events
app.get('/events', async (req, res) => {
  try {
    const sql = `
      SELECT event.*, games.name AS "gameName"
      FROM event
      INNER JOIN games ON event.gameid = games.id
    `;
    const resDb = await db.query(sql, []);
    res.json(resDb.rows);
  } catch (err) {
    console.error('❌ DB error in /events:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /listGame
app.get('/listGame', async (req, res) => {
  try {
    const sql = `SELECT * from games`;
    const resDb = await db.query(sql, []);
    res.json(resDb.rows);
  } catch (err) {
    console.error('❌ DB error in /listGame:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /updateContent
app.post('/updateContent', async (req, res) => {
  const { gameId, selectedDate, content } = req.body;
  if (!gameId) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: gameId là bắt buộc.' });
  }

  const game = await getGameByIdAsync(gameId);
  if (!game) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: game' });
  }

  try {
    const params = {
      date: dayjs(selectedDate).format("DD/MM/YYYY"),
      name: game.name,
      events: [content || ''],
      isAppendOldText: false
    };

    await axios.post(GOOGLE_SCRIPT_URL, params, {
      headers: { "Content-Type": "application/json" }
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ lỗi cập nhật google sheet:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /getContent
app.post('/getContent', async (req, res) => {
  const { gameId, selectedDate, action } = req.body;
  if (!gameId) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: gameId là bắt buộc.' });
  }

  const game = await getGameByIdAsync(gameId);
  if (!game) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: game' });
  }

  try {
    const params = {
      date: dayjs(selectedDate).format("DD/MM/YYYY"),
      name: game.name,
      action: action || 'GetDataHtml'
    };

    const response = await axios.post(GOOGLE_SCRIPT_URL, params, {
      headers: { "Content-Type": "application/json" }
    });

    const sql = `SELECT event.* FROM event WHERE event.gameid = $1`;
    const resDb = await db.query(sql, [gameId]);

    res.json({ data: response.data.data, events: resDb.rows });
  } catch (err) {
    console.error("❌ lỗi đọc google sheet:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /createNewGallery
app.post('/createNewGallery', async (req, res) => {
  const { gameId, galleryName, IsContent, publicDate } = req.body;
  if (!gameId || !galleryName) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: gameId, galleryName là bắt buộc.' });
  }

  const game = await getGameByIdAsync(gameId);
  if (!game) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: game' });
  }

  let postSlug = '';

  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    let form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('post[name]', `${galleryName} - ${game.app_name}`);
    form.append('blog_id', '1');
    form.append('post[cms_page_blog_id]', '1');
    form.append('post[type]', 'gallery');
    form.append('vo-action', 'insert');

    const data = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      body: form
    }, datas.cookies);

    const insertSql = `
      INSERT INTO event (gameid, name, gallery_id, "IsContent", post_slug)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `;
    await db.query(insertSql, [gameId, galleryName, data.gallery_id, IsContent, data.post_slug]);

    form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('tag_group_id', '18');
    form.append('tag_id', game.tagId);
    form.append('id', data.gallery_id);
    form.append('relate_id', data.gallery_id);
    form.append('type', 'gallery');
    form.append('vo-action', 'tag_group_relate_gallery');

    await fetchLg('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      body: form
    }, datas.cookies);

    const currentDate = dayjs();
    const pastDate = currentDate.subtract(7, 'hour');

    form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('vo-action', 'update_gallery_profile');
    form.append('post[id]', data.gallery_id);
    form.append('id', data.gallery_id);
    form.append('post[cms_page_blog_id]', '1');
    form.append('publish_date', publicDate);
    form.append('post[publish][month]', (dayjs(publicDate).month() + 1).toString());
    form.append('post[publish][day]', dayjs(publicDate).date().toString());
    form.append('post[publish][year]', dayjs(publicDate).year().toString());
    form.append('post[publish][hour]', pastDate.format('h'));
    form.append('post[publish][minute]', pastDate.format('mm'));
    form.append('post[publish][meridian]', pastDate.format('A'));

    await fetchLg('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      body: form
    }, datas.cookies);

    postSlug = data.post_slug;

    try {
      const params = {
        date: dayjs(publicDate).format("DD/MM/YYYY"),
        name: game.name,
        events: [`<p>-Added gallery <span style="color: rgb(255, 0, 0)">${galleryName}</span></p><p><a href="https://my.liquidandgrit.com/library/gallery/${postSlug}" rel="noopener noreferrer" target="_blank" style="color: rgb(17, 85, 204);">https://my.liquidandgrit.com/library/gallery/${postSlug}</a></p>`]
      };
      await axios.post(GOOGLE_SCRIPT_URL, params, {
        headers: { "Content-Type": "application/json" }
      });
    } catch (gErr) {
      console.error("❌ lỗi tạo google sheet:", gErr.message);
    }

    res.json({
      success: true,
      result: {
        gallery_id: data.gallery_id,
        post_slug: data.post_slug
      }
    });
  } catch (err) {
    console.error("❌ lỗi tạo gallery:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /deleteEvent
app.post('/deleteEvent', async (req, res) => {
  const { eventId } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: eventId' });
  }

  try {
    const deleteSql = `DELETE FROM event WHERE id = $1`;
    await db.query(deleteSql, [eventId]);
    res.json({
      success: true,
      message: 'Xóa sự kiện thành công',
      deletedId: eventId
    });
  } catch (error) {
    console.error("❌ Error deleteEvent:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const VIETNAMESE_DAYS = [
  "Chủ nhật",
  "Thứ hai",
  "Thứ ba",
  "Thứ tư",
  "Thứ năm",
  "Thứ sáu",
  "Thứ bảy"
];

// POST /get_event_suggest
app.post('/get_event_suggest', async (req, res) => {
  const { gameId, selectedDate } = req.body;

  if (!gameId || !selectedDate) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: gameId và selectedDate là bắt buộc.' });
  }

  try {
    const cleanDateStr = selectedDate ? selectedDate.toString().replace(/\//g, '-') : '';
    const baseDate = dayjs(cleanDateStr);
    const formattedDate = baseDate.isValid() ? baseDate.format('YYYY-MM-DD') : selectedDate;
    const parsedGameId = parseInt(gameId, 10);

    const selectSql = `
      SELECT DISTINCT 
        e.id,
        e.name,
        e.g_name,
        e.gallery_id,
        e.default_day,
        e.post_slug,
        COALESCE(NULLIF(a."from", ''), a.date)::date AS raw_from,
        TO_CHAR(COALESCE(NULLIF(a."from", ''), a.date)::date, 'YYYY/MM/DD') AS "from",
        TO_CHAR(COALESCE(NULLIF(a."to", ''), a.date)::date, 'YYYY/MM/DD') AS "to",
        GREATEST(0, (COALESCE(NULLIF(a."to", ''), a.date)::date - COALESCE(NULLIF(a."from", ''), a.date)::date)) AS totalday,
        CASE 
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '7 days') THEN 'last-week'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '14 days') THEN 'two-weeks-ago'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '1 day') THEN 'day-back-1'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '2 days') THEN 'day-back-2'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '3 days') THEN 'day-back-3'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '4 days') THEN 'day-back-4'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '5 days') THEN 'day-back-5'
          WHEN COALESCE(NULLIF(a."from", ''), a.date)::date = ($1::date - INTERVAL '6 days') THEN 'day-back-6'
        END AS group_key
      FROM action a
      INNER JOIN event e ON e.id = a.eventid
      WHERE e.gameid = $2
        AND COALESCE(NULLIF(a."from", ''), a.date)::date IN (
          $1::date - INTERVAL '7 days',
          $1::date - INTERVAL '14 days',
          $1::date - INTERVAL '1 day',
          $1::date - INTERVAL '2 days',
          $1::date - INTERVAL '3 days',
          $1::date - INTERVAL '4 days',
          $1::date - INTERVAL '5 days',
          $1::date - INTERVAL '6 days'
        )
      ORDER BY raw_from DESC
    `;

    const result = await db.query(selectSql, [formattedDate, parsedGameId]);
    const rows = result.rows;

    const getDayName = (d) => VIETNAMESE_DAYS[d.day()];

    const groupDefs = [
      { key: 'last-week', daysBack: 7, title: (d) => `📅 ${getDayName(d)} (Tuần trước)`, badgeTag: '1 tuần trước' },
      { key: 'two-weeks-ago', daysBack: 14, title: (d) => `📅 ${getDayName(d)} (2 tuần trước)`, badgeTag: '2 tuần trước' },
      { key: 'day-back-1', daysBack: 1, title: (d) => `🗓️ ${getDayName(d)} (Hôm qua)`, badgeTag: '-1 ngày' },
      { key: 'day-back-2', daysBack: 2, title: (d) => `🗓️ ${getDayName(d)} (-2 ngày)`, badgeTag: '-2 ngày' },
      { key: 'day-back-3', daysBack: 3, title: (d) => `🗓️ ${getDayName(d)} (-3 ngày)`, badgeTag: '-3 ngày' },
      { key: 'day-back-4', daysBack: 4, title: (d) => `🗓️ ${getDayName(d)} (-4 ngày)`, badgeTag: '-4 ngày' },
      { key: 'day-back-5', daysBack: 5, title: (d) => `🗓️ ${getDayName(d)} (-5 ngày)`, badgeTag: '-5 ngày' },
      { key: 'day-back-6', daysBack: 6, title: (d) => `🗓️ ${getDayName(d)} (-6 ngày)`, badgeTag: '-6 ngày' }
    ];

    const responseGroups = [];

    for (const def of groupDefs) {
      const targetDate = baseDate.subtract(def.daysBack, 'day');
      const matchingRows = rows.filter(r => r.group_key === def.key);

      if (matchingRows.length > 0) {
        responseGroups.push({
          key: def.key,
          title: def.title(targetDate),
          dateStr: targetDate.format('DD/MM/YYYY'),
          badgeTag: def.badgeTag,
          events: matchingRows.map((r, idx) => ({
            key: `suggest-${def.key}-${r.id}-${idx}`,
            id: r.id.toString(),
            name: r.name || '',
            g_name: r.g_name || '',
            gallery_id: r.gallery_id,
            default_day: r.default_day,
            post_slug: r.post_slug || '',
            from: r.from,
            to: r.to,
            totalday: typeof r.totalday === 'number' ? r.totalday : parseInt(r.totalday || 0, 10)
          }))
        });
      }
    }

    return res.json(responseGroups);
  } catch (err) {
    console.error('Lỗi server /get_event_suggest:', err.message);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// POST /event
app.post('/event', async (req, res) => {
  const { name, gallery_id, g_name, gameId, default_day, eventId, post_slug } = req.body;

  if (!name || !gallery_id) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: name, gallery_id là bắt buộc.' });
  }

  try {
    if (eventId) {
      const updateSql = `
        UPDATE event 
        SET name = $1, gallery_id = $2, g_name = $3, gameid = $4, default_day = $5, post_slug = $7
        WHERE id = $6
      `;
      await db.query(updateSql, [name, gallery_id, g_name, gameId, default_day === '' ? null : default_day, eventId, post_slug]);
      res.json({
        success: true,
        lastedId: eventId,
        name,
        gallery_id,
        g_name
      });
    } else {
      const insertSql = `
        INSERT INTO event (gameid, name, gallery_id, default_day, g_name, post_slug)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `;
      const resDb = await db.query(insertSql, [gameId, name, gallery_id, default_day === '' ? null : default_day, g_name, post_slug]);
      res.json({
        success: true,
        lastedId: resDb.rows[0].id,
        name,
        gallery_id,
        g_name
      });
    }
  } catch (err) {
    console.error('❌ Query error in /event:', err.message);
    res.status(500).json({ error: 'Lỗi khi lưu sự kiện.' });
  }
});

// POST /action
app.post('/action', async (req, res) => {
  const { id, event_id, date, from, to, type } = req.body;

  if (!event_id || !date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const event = await getEventByIdAsync(event_id);
  let str = '';

  try {
    if (type !== 'nochanged') {
      if (!event) {
        return res.status(400).json({ error: 'không tìm thấy event' });
      }

      const datas = await getStoredCookies();
      if (!datas || Object.keys(datas).length === 0) {
        return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      }

      let form = new FormData();
      form.append('csrf', datas.csrf);
      form.append('action', "getEventsById");
      form.append('plugin', "event");
      form.append('cms_page_blog_gallery_id', event.gallery_id);

      let data = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cms/plugin', {
        method: 'POST',
        body: form
      }, datas.cookies);

      form = new FormData();
      form.append('csrf', datas.csrf);
      form.append('end', dayjs(to).format("MMMM D, YYYY"));
      form.append('start', dayjs(from).format("MMMM D, YYYY"));
      form.append('plugin', "event");
      form.append('name', (event.g_name || '') !== '' ? event.name : '');
      form.append('action', "event_add_item");
      form.append('order_index', data.events ? data.events.length : 0);
      form.append('cms_page_blog_gallery_id', event.gallery_id);

      data = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cms/plugin', {
        method: 'POST',
        body: form
      }, datas.cookies);

      let strDate = '';
      if (from === to) {
        strDate = `${dayjs(from).date()}`;
      } else if (dayjs(from).month() === dayjs(to).month()) {
        strDate = `${dayjs(from).date()}-${dayjs(to).date()}`;
      } else {
        strDate = `${dayjs(from).date()}-${dayjs(to).month() + 1}/${dayjs(to).date()}`;
      }

      const extra = type === 'image' ? `/ image ` : (type === 'video' ? '/ image/ video ' : '');
      str = (event.g_name || '') !== '' ? `-Added tracker date ${extra}for ${event.g_name} ( ${event.name} ) (${strDate})` : `-Added tracker date ${extra}for ${event.name} (${strDate})`;
    } else {
      str = 'No Change';
    }

    const params = {
      date: dayjs(date).format("DD/MM/YYYY"),
      name: event?.game_name || '',
      events: [str]
    };

    await axios.post(GOOGLE_SCRIPT_URL, params, {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("❌ Error calling Google Sheet:", err.message);
    return res.status(500).json({ error: err.message });
  }

  try {
    if (id) {
      const checkSql = `SELECT status FROM action WHERE id = $1`;
      const resDb = await db.query(checkSql, [id]);
      const row = resDb.rows[0];

      if (row && row.status === '1') {
        return res.json({ id, status: row.status, message: "Already successful. No update." });
      }

      const updateSql = `
        UPDATE action
        SET eventid = $1, date = $2, "from" = $3, "to" = $4, status = '1'
        WHERE id = $5
      `;
      await db.query(updateSql, [event_id, date, from || '', to || '', id]);
      return res.json({ id, status: '1', message: "Updated" });
    } else {
      const insertSql = `
        INSERT INTO action (eventid, date, status, "from", "to", type)
        VALUES ($1, $2, '1', $3, $4, $5) RETURNING id
      `;
      const resDb = await db.query(insertSql, [event_id, date, from || '', to || '', type]);
      return res.json({ id: resDb.rows[0].id, status: '1', message: "Inserted" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /actions
app.post('/actions', async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'Payload must be an array' });
  if (records.length === 0) return res.json([]);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const results = [];

    for (const record of records) {
      const { id, event_id, date, from, to, status, isDelete, type } = record;

      if (id) {
        const resCheck = await client.query(`SELECT status FROM action WHERE id = $1`, [id]);
        const row = resCheck.rows[0];

        if (row?.status === '1') {
          results.push({ id, status: '1', message: 'Already success. Skipped.' });
          continue;
        }

        if (isDelete) {
          await client.query(`DELETE FROM action WHERE id = $1`, [id]);
          results.push({ id, status: status || '0' });
        } else {
          await client.query(
            `UPDATE action SET eventid = $1, date = $2, "from" = $3, "to" = $4, status = $5, type=$6 WHERE id = $7`,
            [event_id, date, from || '', to || '', status || '0', type, id]
          );
          results.push({ id, status: status || '0' });
        }
      } else {
        const resInsert = await client.query(
          `INSERT INTO action (eventid, date, status, "from", "to", type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [event_id, date, status || '0', from || '', to || '', type]
        );
        results.push({ id: resInsert.rows[0].id, status: status || '0' });
      }
    }

    await client.query("COMMIT");
    res.json(results);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Transaction Error:", err.message);
    res.status(500).json({ error: 'Transaction failed', details: err.message });
  } finally {
    client.release();
  }
});

// POST /show-data
app.post('/show-data', async (req, res) => {
  const { gameId, startDate } = req.body;
  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    let tagId = '';
    const game = await getGameByIdAsync(gameId);
    if (game) {
      tagId = game.tagId || game.tagid;
    }

    const currentDate = dayjs();
    const obj = JSON.parse('{"date_range": ["2025-12-23", "2026-01-21"], "search": "", "view": ["activity"], "tag26": ["136034"], "limit": 500, "tag18": ["684110"], "init": 0, "page": 0, "category2": [], "tag37": [], "tag38": [], "tag28": []}');
    obj.date_range = [startDate, currentDate.add(30, "day").format('YYYY-MM-DD')];
    obj.tag18 = [tagId.toString()];
    obj.limit = "500";

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('plugin', 'event');
    form.append('action', 'searchItem');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj));

    const responseData = await fetchLgJson('https://my.liquidandgrit.com/action/public/cms/plugin', {
      method: 'POST',
      body: form
    }, datas.cookies);

    res.json({
      success: true,
      content_html: responseData.content_html || "ok"
    });
  } catch (error) {
    console.error("❌ Error in /show-data:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /vewImage
app.post('/vewImage', async (req, res) => {
  const { event_id } = req.body;

  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    let form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('id', event_id);

    const data = await fetchLgJson('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      body: form
    }, datas.cookies);

    if (!data.published_version) {
      return res.status(500).json({ error: "Chưa publish gallery" });
    }

    form = new FormData();
    form.append('blog_id', '1');
    form.append('gallery_version_id', data.published_version);
    form.append('image_size_array', '{"large": {"x": 940, "y": 625}, "small": {"x": 300, "y": 300}}');
    form.append('preview_mode', 'false');
    form.append('csrf', datas.csrf);

    const galleryRes = await fetchLgJson('https://my.liquidandgrit.com/action/public/cms/blog/get-gallery', {
      method: 'POST',
      body: form
    }, datas.cookies);

    res.json({ success: true, result: galleryRes });
  } catch (err) {
    console.error("❌ Error view image:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /check_item
app.post('/check_item', async (req, res) => {
  const { checkData, gameId, selectedDate } = req.body;

  try {
    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    if (checkData && checkData.length === 0) {
      return res.status(500).json({ error: 'No check data found.' });
    }

    let tagId = '';
    const game = await getGameByIdAsync(gameId);
    if (game) {
      tagId = game.tagId || game.tagid;
    }

    const currentDate = dayjs();
    const prevDate = currentDate.subtract(30, 'day');

    const obj = JSON.parse('{"date_range": ["2025-12-23", "2026-01-21"], "search": "", "view": ["activity"], "tag26": ["136034"], "limit": 300, "tag18": ["684110"], "init": 0, "page": 0, "category2": [], "tag37": [], "tag38": [], "tag28": []}');
    obj.date_range = [prevDate.format('YYYY-MM-DD'), currentDate.add(30, "day").format('YYYY-MM-DD')];
    obj.tag18 = [tagId.toString()];
    obj.limit = "300";

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('plugin', 'event');
    form.append('action', 'searchItem');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj));

    const data = await fetchLgJson('https://my.liquidandgrit.com/action/public/cms/plugin', {
      method: 'POST',
      body: form
    }, datas.cookies);

    const extractedRows = parseCndTableRows(data.content_html);

    const resultData = [];
    for (let index = 0; index < checkData.length; index++) {
      const item = checkData[index];
      if (item === '') continue;

      const parsedData = parseTrackerItem(item);
      const ret = { name: item, details: [] };
      let cnt = 0;

      if (!parsedData || !parsedData.startDateObj || !parsedData.eventName) {
        if (parsedData?.eventName !== '') {
          const result = await fetchGalleryInfoCached(`${parsedData.eventName} - ${game.app_name}`, gameId, '', true);
          for (let idx = 0; idx < result.length; idx++) {
            const element = result[idx];
            ret.details.push({
              url: element.permalink,
              editLink: `https://my.liquidandgrit.com/admin/cms/blog/?page=8&gallery-edit-instance=${element.id}`,
              viewImage: `/vewImage/${element.id}`,
              galleryId: element.id
            });
          }
        } else {
          ret.details.push({ url: parsedData?.url });
        }
        cnt = 1;
      } else {
        const startText = parsedData.startDateObj.format('MMMM D, YYYY');
        const endText = parsedData.endDateObj.format('MMMM D, YYYY');
        const eventNameLower = parsedData.eventName.toLowerCase().trim();
        const subEventLower = (parsedData.subEvent || '').toLowerCase().trim();

        for (const rowData of extractedRows) {
          if (rowData.col0 === startText
            && rowData.col1 === endText
            && rowData.col4.toLowerCase().includes(eventNameLower)
            && rowData.col5.toLowerCase() === subEventLower
          ) {
            cnt++;
            if (cnt > 1) break;
          }
        }

        ret.data = parsedData;
        const result = await fetchGalleryInfoCached(parsedData.eventName, gameId, game.app_name, true);

        for (let idx = 0; idx < result.length; idx++) {
          const element = result[idx];
          ret.details.push({
            url: element.permalink,
            editLink: `https://my.liquidandgrit.com/admin/cms/blog/?page=8&gallery-edit-instance=${element.id}`,
            viewImage: `/vewImage/${element.id}`,
            galleryId: element.id
          });
        }
      }

      ret.cnt = cnt;
      ret.valid = cnt === 1;
      resultData.push(ret);
    }

    const selectedDateStr = dayjs(selectedDate).format('MMMM D, YYYY');
    const daysevent = [];
    for (const rowData of extractedRows) {
      if (rowData.col0 === selectedDateStr) {
        daysevent.push({
          start: dayjs(selectedDate).date(),
          to: dayjs(rowData.col1, 'MMMM D, YYYY').date(),
          eventName: rowData.col4.split(' - ')[0],
          subEvent: rowData.col5,
          appName: rowData.col4
        });
      }
    }

    const excludes = daysevent.filter(item => {
      const matched = resultData.find(r => r.data?.eventName.toLowerCase().trim() === item.eventName.toLowerCase().trim() && r.data?.subEvent.toLowerCase().trim() === item.subEvent.toLowerCase().trim());
      return !matched;
    });

    for (const item of excludes) {
      const ret = {
        name: `${item.eventName} ${item.subEvent === '' ? '' : '(' + item.subEvent + ')'} (${item.start}-${item.to})( Other )`,
        details: []
      };

      const result = await fetchGalleryInfoCached(item.appName, gameId);
      if (result?.id) {
        ret.details.push({
          url: result.permalink,
          editLink: `https://my.liquidandgrit.com/admin/cms/blog/?page=8&gallery-edit-instance=${result.id}`,
          viewImage: `/vewImage/${result.id}`,
          galleryId: result.id
        });
      }
      resultData.push(ret);
    }

    res.json({ success: true, resultData });
  } catch (err) {
    console.error("❌ Error in /check_item:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /search-gallery
app.post('/search-gallery', async (req, res) => {
  const { search_keyword, gameId } = req.body;

  try {
    if (!gameId) {
      return res.status(500).json({ error: 'Tim theo game truoc' });
    }

    const datas = await getStoredCookies();
    if (!datas || Object.keys(datas).length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    let tagId = '';
    const game = await getGameByIdAsync(gameId);
    if (game) {
      tagId = game.tagId || game.tagid;
    }

    const obj = JSON.parse('{"category": [], "page": 0, "sort": ["publish_date", "desc"], "tag26": ["136034"], "tag_group_data": 1, "matrix_app_features": 0, "date_range": "", "limit": 0, "init": 0, "tag37": [], "tag38": [], "tag34": [], "tag28": [], "tag18": [], "tag29": [], "tag36": [], "tag45": [], "tag9": [], "tag42": [], "tag32": [], "tag4": [], "tag1": [], "tag2": [], "tag3": [], "tag10": [], "tag12": [], "tag7": [], "tag8": [], "tag11": [], "tag43": [], "tag13": [], "tag22": [], "tag21": [], "search": ""}');
    obj.tag18 = [tagId.toString()];

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('cnd_config_dir', "/cms/blog/gallery");
    form.append('config_case', "gallery");
    form.append('id', '1');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj));

    const data = await fetchLgJson('https://my.liquidandgrit.com/action/public/cms/blog/cnd', {
      method: 'POST',
      body: form
    }, datas.cookies);

    const matchedRows = parseSearchGalleryRows(data.content_html, search_keyword);
    res.json(matchedRows);
  } catch (err) {
    console.error("❌ Error search gallery:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /get-gallery-info
app.post('/get-gallery-info', async (req, res) => {
  const { galleryName, gameId } = req.body;

  try {
    if (!galleryName || !gameId) {
      return res.status(500).json({ error: 'Nhập input truoc' });
    }

    const result = await fetchGalleryInfo(galleryName, gameId);
    res.json(result);
  } catch (err) {
    console.error("❌ Error get-gallery-info:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- STATIC & FRONTEND SPA SERVING ---
app.use(express.static(path.join(__dirname, 'build')));

// Fallback: trả về index.html với các route frontend
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'build', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not Found');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

export default app;