import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Pool } from '@neondatabase/serverless';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import * as cheerio from 'cheerio';

dayjs.extend(customParseFormat);

const app = new Hono();

// Enable CORS
app.use('*', cors());

// Default Google Script URL fallback
const GOOGLE_SCRIPT_URL_DEFAULT = "https://script.google.com/macros/s/AKfycbwzIlzn5gfKE38-mAGx1W7VCPfCu78nYDEnPmb6aUPVRl_dWALFthGYHFYbCSqyB0WLYw/exec";

// In-memory cookies fallback for local development if DB/KV is not available
let memoryCookies = null;

async function ensureSettingsTable(db) {
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

async function getStoredCookies(c) {
  // 1. Try Cloudflare KV if bound
  if (c.env && c.env.COOKIES_KV) {
    try {
      const kvVal = await c.env.COOKIES_KV.get('login_cookies');
      if (kvVal) return JSON.parse(kvVal);
    } catch (err) {
      console.error('KV get error:', err);
    }
  }

  // 2. Try PostgreSQL DB (Persistent across all reloads and deploys)
  try {
    const db = getDb(c);
    await ensureSettingsTable(db);
    const res = await db.query("SELECT value FROM system_settings WHERE key = 'login_cookies'");
    if (res.rows[0]?.value) {
      const parsed = JSON.parse(res.rows[0].value);
      memoryCookies = parsed;
      return parsed;
    }
  } catch (err) {
    console.error('DB cookie get error:', err.message);
  }

  // 3. Fallback to memory
  return memoryCookies || {};
}

async function saveStoredCookies(c, dataStr) {
  const parsed = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
  const jsonString = JSON.stringify(parsed);
  memoryCookies = parsed;

  // 1. Try Cloudflare KV if bound
  if (c.env && c.env.COOKIES_KV) {
    try {
      await c.env.COOKIES_KV.put('login_cookies', jsonString);
    } catch (err) {
      console.error('KV put error:', err);
    }
  }

  // 2. Save to PostgreSQL DB permanently
  try {
    const db = getDb(c);
    await ensureSettingsTable(db);
    await db.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('login_cookies', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [jsonString]);
  } catch (err) {
    console.error('DB cookie save error:', err.message);
  }
}

function getDb(c) {
  const connectionString = c.env?.DATABASE_URL || process.env.DATABASE_URL;
  return new Pool({ connectionString });
}

function getGoogleScriptUrl(c) {
  return c.env?.GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL_DEFAULT;
}

// Helpers
async function getGameByIdAsync(db, gameId) {
  const resDb = await db.query("SELECT * from games WHERE id = $1", [gameId]);
  if (!resDb.rows[0]) return null;
  const row = resDb.rows[0];
  return {
    ...row,
    tagId: row.tagId || row.tagid
  };
}

async function getEventByIdAsync(db, id) {
  const resDb = await db.query('SELECT event.*, games.name as "gameName" FROM event inner join games on event.gameid = games.id WHERE event.id = $1', [id]);
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

const fetchGalleryInfo = async (c, galleryName, gameId, gameName = '', retList = false) => {
  const db = getDb(c);
  const datas = await getStoredCookies(c);
  if (!datas || Object.keys(datas).length === 0) {
    return retList ? [] : {};
  }

  const game = await getGameByIdAsync(db, gameId);
  const tagId = game ? (game.tagId || game.tagid) : '';

  const obj = JSON.parse('{"limit": 10000000, "init": 0, "page": 0, "type": [], "status": [], "category": [], "non_category": [], "tag37": [], "tag38": [], "tag28": [], "tag34": [], "tag18": ["768367"], "tag35": [], "tag21": [], "tag29": [], "tag36": [], "tag22": [], "tag26": [], "tag45": [], "tag42": [], "tag9": [], "tag32": [], "tag4": [], "tag1": [], "tag2": [], "tag3": [], "tag10": [], "tag12": [], "tag7": [], "tag8": [], "tag11": [], "tag43": [], "tag13": [], "search": ""}');
  obj.tag18 = [tagId.toString()];
  obj.search = galleryName;

  const form = new FormData();
  form.append('csrf', datas.csrf);
  form.append('id', '1');
  form.append('vo-action', '');
  form.append('filter_conditions', JSON.stringify(obj));

  const response = await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/post-cnd', {
    method: 'POST',
    headers: {
      Cookie: datas.cookies
    },
    body: form
  });

  const responseData = await response.json();
  const contentList = responseData && responseData.content ? responseData.content : [];

  if (!retList) {
    const foundItem = contentList.find(item => item.name.toLowerCase() === galleryName.toLowerCase());
    return foundItem || {};
  }

  return contentList.filter(item => `${galleryName} - ${gameName}`.toLowerCase().includes(item.name.toLowerCase()));
};

// --- ROUTES ---

// POST /saveLoginData
app.post('/saveLoginData', async (c) => {
  try {
    const body = await c.req.json();
    await saveStoredCookies(c, body.datas);
    return c.json({ success: true });
  } catch (error) {
    console.error('Login failed:', error);
    return c.json({ success: false, message: error.message });
  }
});

// GET /readDataCookies
app.get('/readDataCookies', async (c) => {
  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('id', '1');

    const response = await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/manage', {
      method: 'POST',
      headers: {
        Cookie: datas.cookies
      },
      body: form
    });

    const text = await response.text();
    const data = JSON.parse(text);

    if (!data.blogData) {
      return c.json({ success: true, result: '' });
    }

    return c.json({ success: true, result: JSON.stringify(datas) });
  } catch (err) {
    console.error("❌ loi doc data cookie:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// GET /games?date=YYYY-MM-DD
app.get('/games', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: 'Missing date parameter' }, 400);

  const db = getDb(c);
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

    return c.json(Object.values(result));
  } catch (err) {
    console.error("❌ Error in /games:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /delete_file
app.post('/delete_file', async (c) => {
  const body = await c.req.json();
  const { gallery_id, file } = body;

  if (!gallery_id || !file) {
    return c.json({ error: 'Thiếu dữ liệu: name, gallery_id là bắt buộc.' }, 400);
  }

  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('vo-action', 'delete_file');
    form.append('type', '2');
    form.append('id', gallery_id);
    form.append('file', JSON.stringify(file));

    await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      headers: {
        Cookie: datas.cookies
      },
      body: form
    });

    return c.json({ success: true, result: "OK" });
  } catch (error) {
    console.error(error);
    return c.text('loi khi xóa file.', 500);
  }
});

// POST /getInfo
app.post('/getInfo', async (c) => {
  const body = await c.req.json();
  const { event_id } = body;

  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('id', event_id);

    const response = await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      headers: {
        Cookie: datas.cookies
      },
      body: form
    });

    const data = await response.json();
    return c.json({ success: true, result: data });
  } catch (err) {
    console.error("❌ Error getting info:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /upload
app.post('/upload', async (c) => {
  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    const queryStream = c.req.query('stream') === 'true' || c.req.header('x-stream-upload') === 'true';

    // Direct Streaming Mode: Forward request body stream directly to bypass 128MB RAM Worker limits
    if (queryStream) {
      const customFilename = c.req.query('customFilename') || c.req.header('x-custom-filename') || '';
      const isLastChunk = c.req.query('isLastChunk') === 'true' || c.req.header('x-is-last-chunk') === 'true';
      const orderIndex = c.req.query('order_index') || c.req.header('x-order-index') || '';
      const galleryId = c.req.query('id') || c.req.header('x-gallery-id') || '';

      const reqHeaders = new Headers();
      reqHeaders.set('Cookie', datas.cookies);
      if (c.req.header('content-type')) {
        reqHeaders.set('Content-Type', c.req.header('content-type'));
      }
      reqHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      const resUpload = await fetch('https://my.liquidandgrit.com/action/admin/cms/file-upload-v3', {
        method: 'POST',
        headers: reqHeaders,
        body: c.req.raw.body,
        duplex: 'half'
      });

      const resText = await resUpload.text();
      let uploadResult = null;
      try {
        uploadResult = JSON.parse(resText);
      } catch (parseErr) {
        if (resUpload.ok) {
          uploadResult = { message: resText };
        } else {
          console.error(`Stream upload error: Target server returned non-JSON response (HTTP ${resUpload.status}):`, resText.slice(0, 500));
          return c.json({
            error: `Upstream upload error (HTTP ${resUpload.status}). Server returned HTML or invalid response.`,
            details: resText.slice(0, 300)
          }, resUpload.status >= 400 ? resUpload.status : 500);
        }
      }

      if (customFilename.includes('/') && isLastChunk && uploadResult && uploadResult.file) {
        uploadResult.file.name = customFilename;
        uploadResult.file.order_index = orderIndex;
        uploadResult.file.type = '1';

        const form2 = new FormData();
        form2.append('csrf', datas.csrf);
        form2.append('vo-action', 'save_file');
        form2.append('type', '2');
        form2.append('id', galleryId);
        form2.append('file', JSON.stringify(uploadResult.file));

        await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
          method: 'POST',
          headers: {
            Cookie: datas.cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          body: form2
        });
      }

      return c.json({ success: true, result: uploadResult || "OK" });
    }

    // Standard Form Data Parsing Mode
    const body = await c.req.parseBody();
    const uploadedFile = body['file'];

    if (!uploadedFile) {
      return c.json({ error: 'Missing file' }, 400);
    }

    const customerFilename = (body.customFilename || '').toString();
    const isLastChunk = body.isLastChunk === true || body.isLastChunk === 'true' || body.isLastChunk === '1' || body.isLastChunk === 1;
    const needUpdateFileName = customerFilename.includes('/') && isLastChunk;

    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (key === 'file') continue;
      if (key === 'flowFilename' && !customerFilename.includes('/')) {
        form.append(key, customerFilename);
      } else {
        form.append(key, value);
      }
    }

    if (uploadedFile instanceof Blob || uploadedFile instanceof File) {
      form.append('file', uploadedFile, uploadedFile.name || 'file');
    } else {
      form.append('file', uploadedFile);
    }

    const resUpload = await fetch('https://my.liquidandgrit.com/action/admin/cms/file-upload-v3', {
      method: 'POST',
      headers: {
        Cookie: datas.cookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: form
    });

    const resText = await resUpload.text();
    let uploadResult = null;
    try {
      uploadResult = JSON.parse(resText);
    } catch (parseErr) {
      if (resUpload.ok) {
        uploadResult = { message: resText };
      } else {
        console.error(`Upload error: Target server returned non-JSON response (HTTP ${resUpload.status}):`, resText.slice(0, 500));
        return c.json({
          error: `Upstream upload error (HTTP ${resUpload.status}). Server returned HTML or invalid response.`,
          details: resText.slice(0, 300)
        }, resUpload.status >= 400 ? resUpload.status : 500);
      }
    }

    if (!resUpload.ok || (uploadResult && uploadResult.error)) {
      console.error("Upload error response from upstream:", uploadResult);
      return c.json({
        error: uploadResult?.error || uploadResult?.message || `Upstream returned HTTP ${resUpload.status}`,
        uploadResult
      }, resUpload.status >= 400 ? resUpload.status : 500);
    }

    if (needUpdateFileName && uploadResult && uploadResult.file) {
      uploadResult.file.name = customerFilename;
      uploadResult.file.order_index = body.order_index;
      uploadResult.file.type = '1';

      const form2 = new FormData();
      form2.append('csrf', datas.csrf);
      form2.append('vo-action', 'save_file');
      form2.append('type', '2');
      form2.append('id', body.id);
      form2.append('file', JSON.stringify(uploadResult.file));

      const resEdit = await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
        method: 'POST',
        headers: {
          Cookie: datas.cookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: form2
      });

      if (!resEdit.ok) {
        console.error("Gallery edit update failed with status:", resEdit.status);
      }
    }

    return c.json({ success: true, result: uploadResult || "OK" });
  } catch (err) {
    console.error("Upload error:", err.stack || err.message || err);
    return c.json({ error: `Proxy upload error: ${err.message || err}` }, 500);
  }
});

// GET /events
app.get('/events', async (c) => {
  const db = getDb(c);
  try {
    const sql = `
      SELECT event.*, games.name AS "gameName"
      FROM event
      INNER JOIN games ON event.gameid = games.id
    `;
    const resDb = await db.query(sql, []);
    return c.json(resDb.rows);
  } catch (err) {
    console.error('❌ DB error:', err);
    return c.json({ error: 'Database error' }, 500);
  }
});

// GET /listGame
app.get('/listGame', async (c) => {
  const db = getDb(c);
  try {
    const sql = `SELECT * from games`;
    const resDb = await db.query(sql, []);
    return c.json(resDb.rows);
  } catch (err) {
    console.error('❌ DB error:', err);
    return c.json({ error: 'Database error' }, 500);
  }
});

// POST /updateContent
app.post('/updateContent', async (c) => {
  const body = await c.req.json();
  const { gameId, selectedDate, content } = body;
  if (!gameId) {
    return c.json({ error: 'Thiếu dữ liệu: gameId là bắt buộc.' }, 400);
  }

  const db = getDb(c);
  const game = await getGameByIdAsync(db, gameId);
  if (!game) {
    return c.json({ error: 'Thiếu dữ liệu: game' }, 400);
  }

  try {
    const params = {
      date: dayjs(selectedDate).format("DD/MM/YYYY"),
      name: game.name,
      events: [content || ''],
      isAppendOldText: false
    };

    await fetch(getGoogleScriptUrl(c), {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });

    return c.json({ success: true });
  } catch (err) {
    console.error("❌ lỗi tạo goole sheet:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /getContent
app.post('/getContent', async (c) => {
  const body = await c.req.json();
  const { gameId, selectedDate, action } = body;
  if (!gameId) {
    return c.json({ error: 'Thiếu dữ liệu: gameId là bắt buộc.' }, 400);
  }

  const db = getDb(c);
  const game = await getGameByIdAsync(db, gameId);
  if (!game) {
    return c.json({ error: 'Thiếu dữ liệu: game' }, 400);
  }

  try {
    const params = {
      date: dayjs(selectedDate).format("DD/MM/YYYY"),
      name: game.name,
      action: action || 'GetDataHtml'
    };

    const response = await fetch(getGoogleScriptUrl(c), {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });

    const googleData = await response.json();

    const sql = `
      SELECT event.*
      FROM event where event.gameid = $1
    `;
    const resDb = await db.query(sql, [gameId]);

    return c.json({ data: googleData.data, events: resDb.rows });
  } catch (err) {
    console.error("❌ lỗi tạo goole sheet:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /createNewGallery
app.post('/createNewGallery', async (c) => {
  const body = await c.req.json();
  const { gameId, galleryName, IsContent, publicDate } = body;
  if (!gameId || !galleryName) {
    return c.json({ error: 'Thiếu dữ liệu: gameId, galleryName là bắt buộc.' }, 400);
  }

  const db = getDb(c);
  const game = await getGameByIdAsync(db, gameId);
  if (!game) {
    return c.json({ error: 'Thiếu dữ liệu: game' }, 400);
  }

  let postSlug = '';

  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    let form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('post[name]', `${galleryName} - ${game.app_name}`);
    form.append('blog_id', '1');
    form.append('post[cms_page_blog_id]', '1');
    form.append('post[type]', 'gallery');
    form.append('vo-action', 'insert');

    let response = await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });
    const data = await response.json();

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

    await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });

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

    await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });

    postSlug = data.post_slug;

    // Send to Google Sheet
    try {
      const params = {
        date: dayjs(publicDate).format("DD/MM/YYYY"),
        name: game.name,
        events: [`<p>-Added gallery <span style="color: rgb(255, 0, 0)">${galleryName}</span></p><p><a href="https://my.liquidandgrit.com/library/gallery/${postSlug}" rel="noopener noreferrer" target="_blank" style="color: rgb(17, 85, 204);">https://my.liquidandgrit.com/library/gallery/${postSlug}</a></p>`]
      };
      await fetch(getGoogleScriptUrl(c), {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
      });
    } catch (gErr) {
      console.error("❌ lỗi tạo google sheet:", gErr.message);
    }

    return c.json({
      success: true,
      result: {
        gallery_id: data.gallery_id,
        post_slug: data.post_slug
      }
    });

  } catch (err) {
    console.error("❌ lỗi tạo gallery:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /deleteEvent
app.post('/deleteEvent', async (c) => {
  const body = await c.req.json();
  const { eventId } = body;

  if (!eventId) {
    return c.json({ error: 'Thiếu dữ liệu: eventId' }, 400);
  }

  const db = getDb(c);
  try {
    const deleteSql = `DELETE FROM event WHERE id = $1`;
    await db.query(deleteSql, [eventId]);
    return c.json({
      success: true,
      message: 'Xóa sự kiện thành công',
      deletedId: eventId
    });
  } catch (error) {
    console.error("❌ Error ", error.message);
    return c.json({ error: error.message }, 500);
  }
});

// POST /get_event_suggest
app.post('/get_event_suggest', async (c) => {
  const body = await c.req.json();
  const { gameId, selectedDate } = body;

  if (!gameId || !selectedDate) {
    return c.json({ error: 'Thiếu dữ liệu: gameId và selectedDate là bắt buộc.' }, 400);
  }

  const db = getDb(c);
  try {
    const base = dayjs(selectedDate);
    const dates = [
      base.subtract(7, 'day').format('YYYY/MM/DD'),
      base.subtract(14, 'day').format('YYYY/MM/DD'),
      base.subtract(21, 'day').format('YYYY/MM/DD')
    ];

    const selectSql = `
      SELECT DISTINCT 
        EVENT.*, 
        (ACTION.to::date - ACTION.from::date) AS days_diff 
      FROM ACTION 
      INNER JOIN EVENT ON EVENT.id = ACTION.EVENTId 
      WHERE EVENT.gameid = $1 
      AND ACTION.DATE::date = ANY($2::date[])
      AND EVENT.id NOT IN (
        SELECT EVENTId 
        FROM ACTION 
        WHERE DATE = $3
      )
    `;

    const result = await db.query(selectSql, [gameId, dates, base.format('YYYY/MM/DD')]);
    return c.json(result.rows);
  } catch (err) {
    console.error('Lỗi server:', err.message);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// POST /event
app.post('/event', async (c) => {
  const body = await c.req.json();
  const { name, gallery_id, g_name, gameId, default_day, eventId, post_slug } = body;

  if (!name || !gallery_id) {
    return c.json({ error: 'Thiếu dữ liệu: name, gallery_id là bắt buộc.' }, 400);
  }

  const db = getDb(c);
  try {
    if (eventId) {
      const updateSql = `
        UPDATE event 
        SET name = $1, gallery_id = $2, g_name = $3, gameid = $4, default_day = $5, post_slug = $7
        WHERE id = $6
      `;
      await db.query(updateSql, [name, gallery_id, g_name, gameId, default_day === '' ? null : default_day, eventId, post_slug]);
      return c.json({
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
      return c.json({
        success: true,
        lastedId: resDb.rows[0].id,
        name,
        gallery_id,
        g_name
      });
    }
  } catch (err) {
    console.error('❌ Query error:', err);
    return c.json({ error: 'Lỗi khi lưu sự kiện.' }, 500);
  }
});

// POST /action
app.post('/action', async (c) => {
  const body = await c.req.json();
  const { id, event_id, date, from, to, type } = body;

  if (!event_id || !date) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const db = getDb(c);
  const event = await getEventByIdAsync(db, event_id);
  let str = '';

  try {
    if (type !== 'nochanged') {
      if (!event) {
        return c.json({ error: 'không tìm thấy event' }, 400);
      }

      const datas = await getStoredCookies(c);
      if (!datas || Object.keys(datas).length === 0) {
        return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
      }

      let form = new FormData();
      form.append('csrf', datas.csrf);
      form.append('action', "getEventsById");
      form.append('plugin', "event");
      form.append('cms_page_blog_gallery_id', event.gallery_id);

      let response = await fetch('https://my.liquidandgrit.com/action/admin/cms/plugin', {
        method: 'POST',
        headers: { Cookie: datas.cookies },
        body: form
      });

      let data = await response.json();

      form = new FormData();
      form.append('csrf', datas.csrf);
      form.append('end', dayjs(to).format("MMMM D, YYYY"));
      form.append('start', dayjs(from).format("MMMM D, YYYY"));
      form.append('plugin', "event");
      form.append('name', (event.g_name || '') !== '' ? event.name : '');
      form.append('action', "event_add_item");
      form.append('order_index', data.events ? data.events.length : 0);
      form.append('cms_page_blog_gallery_id', event.gallery_id);

      response = await fetch('https://my.liquidandgrit.com/action/admin/cms/plugin', {
        method: 'POST',
        headers: { Cookie: datas.cookies },
        body: form
      });
      data = await response.json();

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

    await fetch(getGoogleScriptUrl(c), {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });

  } catch (err) {
    console.error("❌ Error calling Google Sheet:", err.message);
    return c.json({ error: err.message }, 500);
  }

  try {
    if (id) {
      const checkSql = `SELECT status FROM action WHERE id = $1`;
      const resDb = await db.query(checkSql, [id]);
      const row = resDb.rows[0];

      if (row && row.status === '1') {
        return c.json({ id, status: row.status, message: "Already successful. No update." });
      }

      const updateSql = `
        UPDATE action
        SET eventid = $1, date = $2, "from" = $3, "to" = $4, status = '1'
        WHERE id = $5
      `;
      await db.query(updateSql, [event_id, date, from || '', to || '', id]);
      return c.json({ id, status: '1', message: "Updated" });
    } else {
      const insertSql = `
        INSERT INTO action (eventid, date, status, "from", "to", type)
        VALUES ($1, $2, '1', $3, $4, $5) RETURNING id
      `;
      const resDb = await db.query(insertSql, [event_id, date, from || '', to || '', type]);
      return c.json({ id: resDb.rows[0].id, status: '1', message: "Inserted" });
    }
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /actions
app.post('/actions', async (c) => {
  const records = await c.req.json();
  if (!Array.isArray(records)) return c.json({ error: 'Payload must be an array' }, 400);
  if (records.length === 0) return c.json([]);

  const pool = getDb(c);
  const client = await pool.connect();
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
    return c.json(results);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Transaction Error:", err);
    return c.json({ error: 'Transaction failed', details: err.message }, 500);
  } finally {
    client.release();
  }
});

// POST /show-data
app.post('/show-data', async (c) => {
  const body = await c.req.json();
  const { gameId, startDate } = body;

  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    const db = getDb(c);
    let tagId = '';
    const game = await getGameByIdAsync(db, gameId);
    if (game) {
      tagId = game.tagId || game.tagid;
    }

    const currentDate = dayjs();
    const obj = JSON.parse('{"date_range": ["2025-12-23", "2026-01-21"], "search": "", "view": ["activity"], "tag26": ["136034"], "limit": 4000, "tag18": ["684110"], "init": 0, "page": 0, "category2": [], "tag37": [], "tag38": [], "tag28": []}');
    obj.date_range = [startDate, currentDate.add(30, "day").format('YYYY-MM-DD')];
    obj.tag18 = [tagId.toString()];
    obj.limit = (Math.floor(Math.random() * (5000 - 100 + 1)) + 100).toString();

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('plugin', 'event');
    form.append('action', 'searchItem');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj));

    const response = await fetch('https://my.liquidandgrit.com/action/public/cms/plugin', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });

    const data = await response.json();
    return c.json({
      success: true,
      content_html: data.content_html
    });
  } catch (error) {
    console.error("❌ Error ", error.message);
    return c.json({ error: error.message }, 500);
  }
});

// POST /vewImage
app.post('/vewImage', async (c) => {
  const body = await c.req.json();
  const { event_id } = body;

  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    let form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('id', event_id);

    let response = await fetch('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });
    const data = await response.json();

    if (!data.published_version) {
      return c.json({ error: "Chưa publish gallery" }, 500);
    }

    form = new FormData();
    form.append('blog_id', '1');
    form.append('gallery_version_id', data.published_version);
    form.append('image_size_array', '{"large": {"x": 940, "y": 625}, "small": {"x": 300, "y": 300}}');
    form.append('preview_mode', 'false');
    form.append('csrf', datas.csrf);

    response = await fetch('https://my.liquidandgrit.com/action/public/cms/blog/get-gallery', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });

    const galleryRes = await response.json();
    return c.json({ success: true, result: galleryRes });
  } catch (err) {
    console.error("❌ Error view image:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /check_item
app.post('/check_item', async (c) => {
  const body = await c.req.json();
  const { checkData, gameId, selectedDate } = body;

  try {
    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    if (checkData && checkData.length === 0) {
      return c.json({ error: 'No check data found.' }, 500);
    }

    const db = getDb(c);
    let tagId = '';
    const game = await getGameByIdAsync(db, gameId);
    if (game) {
      tagId = game.tagId || game.tagid;
    }

    const currentDate = dayjs();
    const prevDate = currentDate.subtract(30, 'day');

    const obj = JSON.parse('{"date_range": ["2025-12-23", "2026-01-21"], "search": "", "view": ["activity"], "tag26": ["136034"], "limit": 4000, "tag18": ["684110"], "init": 0, "page": 0, "category2": [], "tag37": [], "tag38": [], "tag28": []}');
    obj.date_range = [prevDate.format('YYYY-MM-DD'), currentDate.add(30, "day").format('YYYY-MM-DD')];
    obj.tag18 = [tagId.toString()];
    obj.limit = (Math.floor(Math.random() * (5000 - 100 + 1)) + 100).toString();

    const form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('plugin', 'event');
    form.append('action', 'searchItem');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj));

    const response = await fetch('https://my.liquidandgrit.com/action/public/cms/plugin', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });

    const data = await response.json();
    const $ = cheerio.load(data.content_html);
    const rows = $('table.table-cnd tbody tr');

    const resultData = [];
    for (let index = 0; index < checkData.length; index++) {
      const item = checkData[index];
      if (item === '') continue;

      const parsedData = parseTrackerItem(item);
      const ret = { name: item, details: [] };
      let cnt = 0;

      if (!parsedData || !parsedData.startDateObj || !parsedData.eventName) {
        if (parsedData?.eventName !== '') {
          const result = await fetchGalleryInfo(c, `${parsedData.eventName} - ${game.app_name}`, gameId, true);
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
        rows.each((i, row) => {
          const cells = $(row).find('td');
          if ($(cells[0])?.text() === parsedData.startDateObj.format('MMMM D, YYYY')
            && $(cells[1])?.text() === parsedData.endDateObj.format('MMMM D, YYYY')
            && $(cells[4])?.text().toLowerCase().trim().includes(parsedData.eventName.toLowerCase().trim())
            && (parsedData.subEvent || '').toLowerCase().trim() === $(cells[5])?.text().toLowerCase().trim()
          ) {
            cnt++;
          } else if (cnt > 1) {
            return false;
          }
        });

        ret.data = parsedData;
        const result = await fetchGalleryInfo(c, parsedData.eventName, gameId, game.app_name, true);

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

    const daysevent = [];
    rows.each((i, row) => {
      const cells = $(row).find('td');
      if ($(cells[0])?.text() === dayjs(selectedDate).format('MMMM D, YYYY')) {
        daysevent.push({
          start: dayjs(selectedDate).date(),
          to: dayjs($(cells[1])?.text(), 'MMMM D, YYYY').date(),
          eventName: $(cells[4])?.text().split(' - ')[0],
          subEvent: $(cells[5])?.text(),
          appName: $(cells[4])?.text()
        });
      }
    });

    const excludes = daysevent.filter(item => {
      const matched = resultData.find(r => r.data?.eventName.toLowerCase().trim() === item.eventName.toLowerCase().trim() && r.data?.subEvent.toLowerCase().trim() === item.subEvent.toLowerCase().trim());
      return !matched;
    });

    for (const item of excludes) {
      const ret = {
        name: `${item.eventName} ${item.subEvent === '' ? '' : '(' + item.subEvent + ')'} (${item.start}-${item.to})( Other )`,
        details: []
      };

      const result = await fetchGalleryInfo(c, item.appName, gameId);
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

    return c.json({ success: true, resultData });
  } catch (err) {
    console.error("❌ Error ", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /search-gallery
app.post('/search-gallery', async (c) => {
  const body = await c.req.json();
  const { search_keyword, gameId } = body;

  try {
    if (!gameId) {
      return c.json({ error: 'Tim theo game truoc' }, 500);
    }

    const datas = await getStoredCookies(c);
    if (!datas || Object.keys(datas).length === 0) {
      return c.json({ error: 'No cookies or CSRF token found. Please login first.' }, 500);
    }

    const db = getDb(c);
    let tagId = '';
    const game = await getGameByIdAsync(db, gameId);
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

    const response = await fetch('https://my.liquidandgrit.com/action/public/cms/blog/cnd', {
      method: 'POST',
      headers: { Cookie: datas.cookies },
      body: form
    });

    const textData = await response.text();
    const data = JSON.parse(textData);

    const $ = cheerio.load(data.content_html);
    const rows = $('table.view-data tbody tr');
    const matchedRows = [];

    rows.each((i, row) => {
      const link = $(row).find('td a.vo-permalink-url');
      const cells = $(row).find('td');

      if (
        (search_keyword || '') === '' ||
        $(cells[0]).text().toLowerCase().includes(search_keyword.toLowerCase()) ||
        $(cells[2]).text().toLowerCase().includes(search_keyword.toLowerCase())
      ) {
        matchedRows.push({
          title: $(cells[0]).text(),
          href: link.attr('href'),
          sub: $(cells[2]).text(),
        });
      }
    });

    return c.json(Object.values(matchedRows));
  } catch (err) {
    console.error("❌ Error ", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /get-gallery-info
app.post('/get-gallery-info', async (c) => {
  const body = await c.req.json();
  const { galleryName, gameId } = body;

  try {
    if (!galleryName || !gameId) {
      return c.json({ error: 'Nhập input truoc' }, 500);
    }

    const result = await fetchGalleryInfo(c, galleryName, gameId);
    return c.json(result);
  } catch (err) {
    console.error("❌ Error ", err.message);
    return c.json({ error: err.message }, 500);
  }
});

export default app;
