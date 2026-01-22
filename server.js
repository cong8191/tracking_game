require("dotenv").config();
const express = require('express');
const app = express();
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const PORT = process.env.PORT || 3000;
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// --- KẾT NỐI POSTGRES ---
// Thay Client bằng Pool
const { Pool } = require('pg');

// Thay new Client bằng new Pool
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // ⚠️ QUAN TRỌNG: Bắt buộc phải có dòng này khi deploy lên Render/Heroku
  },
  connectionTimeoutMillis: 10000, // ⚠️ QUAN TRỌNG: Tăng thời gian chờ lên 10s (đề phòng DB đang ngủ)
  idleTimeoutMillis: 30000,       // Đóng kết nối nếu rảnh quá 30s
  max: 20,                        // Tối đa 20 kết nối cùng lúc
});

// Test kết nối khi khởi động Server
db.connect()
  .then(client => {
    console.log('✅ Đã kết nối PostgreSQL thành công!');
    client.release(); // Nhả kết nối ngay sau khi test xong
  })
  .catch(err => {
    console.error('❌ Lỗi kết nối Database:', err.message);
    // Không exit process để server vẫn chạy, lỡ DB dậy muộn thì request sau vẫn xử lý được
  });
// ------------------------

const FormData1 = require('form-data');
const { log } = require('console');
const cheerio = require('cheerio');
const { title } = require('process');
const { type } = require('os');
const { constants } = fs;

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwzIlzn5gfKE38-mAGx1W7VCPfCu78nYDEnPmb6aUPVRl_dWALFthGYHFYbCSqyB0WLYw/exec";


app.use(express.json());
app.use(cors());


app.post('/saveLoginData', async (req, res) => {
  try {
    const { datas } = req.body;
    // Lưu cookies và csrfToken vào file
    fs.writeFileSync('cookies.json', datas);
    res.json({ success: true });
  } catch (error) {
    console.error('Login failed:', error);
    res.json({ success: false, message: error });
  }
});

app.get('/readDataCookies', async (req, res) => {
  try {
    const dataStr = fs.existsSync('cookies.json') ? fs.readFileSync('cookies.json', 'utf-8') : '';
    let form = new FormData();

    const datas = dataStr != '' ? JSON.parse(dataStr) : {};

    if (datas.length === 0) {
      res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      return;
    }

    form.append('csrf', datas.csrf);
    form.append('id', '1');

    let response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/manage', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    const data = JSON.parse(response.data);

    if (!data.blogData) {
      res.json({ success: true, result: '' });
      return;
    }

    res.json({ success: true, result: dataStr });
  } catch (err) {
    console.error("❌ loi doc data cookie:", err.message);
    res.status(500).json({ error: err.message });
    return;
  }

});
// API: /games?date=YYYY-MM-DD
app.get('/games', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Missing date parameter' });

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

  // Postgres dùng $1 thay vì ?
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

  // db.all -> db.query
  db.query(sql, [], (err, resDb) => {
    if (err) return res.status(500).json({ error: err.message });
    const rows = resDb.rows; // Lấy rows từ kết quả

    db.query(sqlAction, [date], (err2, resAction) => {
      if (err2) return res.status(500).json({ error: err2.message });
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

      // gán event-details vào đúng game
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
    });
  });
});

app.post('/getInfo', async (req, res) => {
  const { event_id } = req.body;
  try {
    const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

    console.log(datas);
    if (datas.length === 0) {
      res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      return;
    }



    let form = new FormData();

    form.append('csrf', datas.csrf);
    form.append('id', event_id);

    let response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    data = JSON.parse(response.data);


    res.json({ success: true, result: data });

  } catch (err) {
    console.error("❌ Error calling Google Sheet:", err.message);
    res.status(500).json({ error: err.message });
    return;
  }
});

const upload2 = multer({ dest: 'uploads/' });
app.post('/upload', upload2.single('file'), async (req, res) => {
  try {
    const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

    if (datas.length === 0) {
      return res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Missing file' });
    }

    const form = new FormData1();
    for (const [key, value] of Object.entries(req.body)) {
      form.append(key, value);
    }

    // Stream file thay vì dùng buffer
    const fileStream = fs.createReadStream(req.file.path);
    form.append('file', fileStream, req.file.originalname);

    const response = await axios.post(
      'https://my.liquidandgrit.com/action/admin/cms/file-upload-v3',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Cookie: datas.cookies
        }
      }
    );

    // Xóa file tạm sau khi gửi xong
    fs.unlink(req.file.path, () => { });

    res.json({ success: true, result: 'OK' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Proxy error while uploading.');
  }
});

app.get('/events', async (req, res) => {
  const sql = `
    SELECT event.*, games.name AS "gameName"
    FROM event
    INNER JOIN games ON event.gameid = games.id
  `;

  db.query(sql, [], (err, resDb) => {
    if (err) {
      console.error('❌ DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(resDb.rows); // Lấy .rows
  });
});

app.get('/listGame', async (req, res) => {
  const sql = `
    SELECT * from games
  `;

  db.query(sql, [], (err, resDb) => {
    if (err) {
      console.error('❌ DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(resDb.rows);
  });
});


function getEventByIdAsync(id) {
  return new Promise((resolve, reject) => {
    // Postgres dùng $1
    db.query('SELECT event.*, games.name as "gameName" FROM event inner join games on event.gameid = games.id WHERE event.id = $1', [id], (err, resDb) => {
      if (err) return reject(err);
      if (!resDb.rows[0]) return resolve(null); // Lấy phần tử đầu tiên

      const row = resDb.rows[0];
      const eventObject = {
        event_id: row.id,
        name: row.name,
        gallery_id: row.gallery_id,
        g_name: row.g_name,
        game_name: row.gameName
      };

      resolve(eventObject);
    });
  });
}

app.post('/createNewGallery', async (req, res) => {
  const { gameId, galleryName, IsContent, publicDate } = req.body;
  if (!gameId || !galleryName) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: gameId, galleryName là bắt buộc.' });
  }

  const game = await getGameByIdAsync(gameId);
  if (!game) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: game' });
  }

  try {

    const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

    console.log(datas);
    if (datas.length === 0) {
      res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      return;
    }

    let form = new FormData();

    form.append('csrf', datas.csrf);
    form.append('post[name]', `${galleryName} - ${game.app_name}`);
    form.append('blog_id', '1');
    form.append('post[cms_page_blog_id]', '1');
    form.append('post[type]', 'gallery');
    form.append('vo-action', 'insert');

    let response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    const data = JSON.parse(response.data);

    const insertSql = `
      INSERT INTO event (gameid, name, gallery_id, "IsContent", post_slug)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `;
    db.query(insertSql, [gameId, galleryName, data.gallery_id, IsContent, data.post_slug], function (err, resDb) {
      if (err) {
        console.error('❌ Insert error:', err);
        return res.status(500).json({ error: 'Lỗi khi thêm sự kiện.' });
      }
    });

    form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('tag_group_id', '18');
    form.append('tag_id', game.tagId);
    form.append('id', data.gallery_id);
    form.append('relate_id', data.gallery_id);
    form.append('type', 'gallery');
    form.append('vo-action', 'tag_group_relate_gallery');

    response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });


    const currentDate = dayjs();

    form = new FormData();
    form.append('csrf', datas.csrf);
    form.append('vo-action', 'update_gallery_profile');
    form.append('post[id]', data.gallery_id);
    form.append('id', data.gallery_id);
    form.append('post[cms_page_blog_id]', '1');
    form.append('publish_date', publicDate);
    form.append('post[publish][month]', dayjs(publicDate).month() + 1);
    form.append('post[publish][day]', dayjs(publicDate).date());
    form.append('post[publish][year]', dayjs(publicDate).year());
    form.append('post[publish][hour]', currentDate.format('h'));
    form.append('post[publish][minute]', currentDate.format('mm'));
    form.append('post[publish][meridian]', currentDate.format('A'));

    response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/gallery-edit', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    res.json({
      success: true,
      result: {
        gallery_id: data.gallery_id,
        post_slug: data.post_slug
      }
    });
    // data.gallery_id
    // data.post_slug

  } catch (err) {
    console.error("❌ lỗi tạo gallery:", err.message);
    res.status(500).json({ error: err.message });
    return;
  }

});

app.post('/event', (req, res) => {
  const { name, gallery_id, g_name, gameId, default_day, eventId, post_slug } = req.body;

  if (!name || !gallery_id) {
    return res.status(400).json({ error: 'Thiếu dữ liệu: name, gallery_id là bắt buộc.' });
  }

  if (eventId) {
    // Trường hợp UPDATE
    // Thay ? bằng $1, $2...
    const updateSql = `
      UPDATE event 
      SET name = $1, gallery_id = $2, g_name = $3, gameid = $4, default_day = $5, post_slug = $7
      WHERE id = $6
    `;
    db.query(updateSql, [name, gallery_id, g_name, gameId, default_day == '' ? null : default_day, eventId, post_slug], function (err) {
      if (err) {
        console.error('❌ Update error:', err);
        return res.status(500).json({ error: 'Lỗi khi cập nhật sự kiện.' });
      }

      res.json({
        success: true,
        lastedId: eventId,
        name,
        gallery_id,
        g_name
      });
    });
  } else {
    // Trường hợp INSERT
    // Postgres cần RETURNING id để lấy ID vừa tạo
    const insertSql = `
      INSERT INTO event (gameid, name, gallery_id, default_day, g_name, post_slug)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `;
    db.query(insertSql, [gameId, name, gallery_id, default_day == '' ? null : default_day, g_name, post_slug], function (err, resDb) {
      if (err) {
        console.error('❌ Insert error:', err);
        return res.status(500).json({ error: 'Lỗi khi thêm sự kiện.' });
      }

      // Postgres trả ID trong result.rows
      res.json({
        success: true,
        lastedId: resDb.rows[0].id,
        name,
        gallery_id,
        g_name
      });
    });
  }
});


app.post('/action', async (req, res) => {
  const { id, event_id, date, from, to, type, gameId } = req.body;

  let str = '';

  if (!event_id || !date) {
        return res.status(400).json({ error: 'Missing required fields' });
  }

  const event = await getEventByIdAsync(event_id);

  try {
    if (type != 'nochanged') {

      if (!event) {
        return res.status(400).json({ error: 'không tìm thấy event' });
      }

      const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];
      console.log(datas);

      if (datas.length === 0) {
        res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
        return;
      }

      let form = new FormData();
      form.append('csrf', datas.csrf);

      form.append('action', "getEventsById");
      form.append('plugin', "event");
      form.append('cms_page_blog_gallery_id', event.gallery_id);




      console.log("bat dau goi");

      let response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/plugin', form, {
        headers: {
          Cookie: datas.cookies,
          "Content-Type": "text/html; charset=UTF-8",
        },
        responseType: "text"
      });

      let data = JSON.parse(response.data);


      form = new FormData();
      form.append('csrf', datas.csrf);

      form.append('end', dayjs(to).format("MMMM D, YYYY"));
      form.append('start', dayjs(from).format("MMMM D, YYYY"));
      form.append('plugin', "event");
      form.append('name', (event.g_name || '') != '' ? event.name : '');
      form.append('action', "event_add_item");
      form.append('order_index', data.events.length);
      form.append('cms_page_blog_gallery_id', event.gallery_id);

      response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/plugin', form, {
        headers: {
          Cookie: datas.cookies,
          "Content-Type": "text/html; charset=UTF-8",
        },
        responseType: "text"
      });

      data = JSON.parse(response.data);

      console.log(data);

      let strDate = ''
      if(from == to) {
        strDate = `${dayjs(from).date()}`;
      } else if (dayjs(from).month() === dayjs(to).month()) {
        strDate = `${dayjs(from).date()}-${dayjs(to).date()}`;
      } else {
        strDate = `${dayjs(from).date()}-${dayjs(to).month() + 1}/${dayjs(to).date()}`;
      }

      const extra = type == 'image' ? `/ image ` : (type == 'video' ? '/ image/ video ' : '');
      str = (event.g_name || '') != '' ? `-Added tracker date ${extra}for ${event.g_name} ( ${event.name} ) (${strDate})` : `-Added tracker date ${extra}for ${event.name} (${strDate})`


    } else {
      str = 'No Change';
    }

    const params = {
      date: dayjs(date).format("DD/MM/YYYY"),
      name: event.game_name,
      events: [str]
    }

    response = await axios.post(GOOGLE_SCRIPT_URL, params, {
      headers: { "Content-Type": "application/json" }
    });

    console.log("thanh cong")
    // res.json({ success: true, result: response.data });
    // return;


  } catch (err) {
    console.error("❌ Error calling Google Sheet:", err.message);
    res.status(500).json({ error: err.message });
    return;
  }


  if (id) {
    // Nếu có ID, kiểm tra xem đã thành công chưa
    const checkSql = `SELECT status FROM action WHERE id = $1`;
    db.query(checkSql, [id], (err, resDb) => {
      if (err) return res.status(500).json({ error: err.message });
      const row = resDb.rows[0];

      if (row && row.status === '1') {
        // Nếu đã thành công thì bỏ qua
        return res.json({ id, status: row.status, message: "Already successful. No update." });
      }

      // Nếu chưa thành công → update và đặt lại status = '0'
      const updateSql = `
        UPDATE action
        SET eventid = $1, date = $2, "from" = $3, "to" = $4, status = '1'
        WHERE id = $5
      `;
      db.query(updateSql, [event_id, date, from || '', to || '', id], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ id, status: '1', message: "Updated" });
      });
    });

  } else {
    // Nếu không có ID → insert mới với status = '1'
    const insertSql = `
      INSERT INTO action (eventid, date, status, "from", "to", type)
      VALUES ($1, $2, '1', $3, $4, $5) RETURNING id
    `;
    db.query(insertSql, [event_id, date, from || '', to || '', type], function (err3, resDb) {
      if (err3) return res.status(500).json({ error: err3.message });
      res.json({ id: resDb.rows[0].id, status: '1', message: "Inserted" });
    });
  }
});

// ROUTE NÀY THAY ĐỔI NHIỀU NHẤT VÌ POSTGRES KHÔNG CÓ db.serialize
app.post('/actions', async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'Payload must be an array' });
  if (records.length === 0) return res.json([]);

  // Dùng Async/Await để xử lý Transaction trong Postgres
  const client = await db.connect(); // Mượn client để transaction an toàn hơn
  try {
    await client.query("BEGIN"); // BEGIN TRANSACTION

    const results = [];

    // Duyệt qua từng record
    for (const record of records) {
      const { id, event_id, date, from, to, status, isDelete, type } = record;

      if (id) {
        // Check status
        const resCheck = await client.query(`SELECT status FROM action WHERE id = $1`, [id]);
        const row = resCheck.rows[0];

        if (row?.status === '1') {
          results.push({ id, status: '1', message: 'Already success. Skipped.' });
          continue; // Bỏ qua vòng lặp này
        }

        if (isDelete) {
          await client.query(`DELETE FROM action WHERE id = $1`, [id]);
          results.push({ id, status: status || '0' });
        } else {
          // Update
          await client.query(
            `UPDATE action SET eventid = $1, date = $2, "from" = $3, "to" = $4, status = $5, type=$6 WHERE id = $7`,
            [event_id, date, from || '', to || '', status || '0', type, id]
          );
          results.push({ id, status: status || '0' });
        }
      } else {
        // INSERT
        const resInsert = await client.query(
          `INSERT INTO action (eventid, date, status, "from", "to", type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [event_id, date, status || '0', from || '', to || '', type]
        );
        results.push({ id: resInsert.rows[0].id, status: status || '0' });
      }
    }

    await client.query("COMMIT"); // Commit nếu mọi thứ ok
    res.json(results);

  } catch (err) {
    await client.query("ROLLBACK"); // Rollback nếu lỗi
    console.error("Transaction Error:", err);
    res.status(500).json({ error: 'Transaction failed', details: err.message });
  } finally {
    client.release(); // Trả kết nối về pool
  }
});


function getGameByIdAsync(gameId) {

  return new Promise((resolve, reject) => {
    // Postgres dùng $1
    db.query("SELECT * from games WHERE id = $1", [gameId], (err, resDb) => {
      if (err) return reject(err);
      if (!resDb.rows[0]) return resolve(null);

      const row = resDb.rows[0];
      console.log(JSON.stringify(row));

      const eventObject = {
        ...row,
        tagId: row.tagId, // Cẩn thận case-sensitive: DB Postgres thường trả về lowercase cột (tagid)
      };

      resolve(eventObject);
    });
  });
}

app.post('/show-data', async (req, res) => {
  const { gameId } = req.body;
  try {
    const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

    if (datas.length === 0) {
      res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      return;
    }

    let tagId = ''

    const game = await getGameByIdAsync(gameId);

    if (game) {
      // Lưu ý: Postgres thường trả về tên cột thường. Hãy check DB nếu cột là tagId hay tagid
      tagId = game.tagId || game.tagid;
    }

    // tagId = '1552'
    const currentDate = dayjs();
    const prevDate = currentDate.subtract(30, 'day')

    const obj = JSON.parse('{"date_range": ["2025-12-23", "2026-01-21"], "search": "", "view": ["activity"], "tag26": ["136034"], "limit": 4000, "tag18": ["684110"], "init": 0, "page": 0, "category2": [], "tag37": [], "tag38": [], "tag28": []}');
    obj.date_range = [prevDate.format('YYYY-MM-DD'), currentDate.format('YYYY-MM-DD')];
    obj.tag18 = [tagId.toString()];
    obj.limit = (Math.floor(Math.random() * (5000 - 100 + 1)) + 100).toString()
    let form = new FormData();

    form.append('csrf', datas.csrf);
    form.append('plugin', 'event');
    form.append('action', 'searchItem');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj))

    console.log(form);

    let response = await axios.post('https://my.liquidandgrit.com/action/public/cms/plugin', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    let data = JSON.parse(response.data);

    res.json({
      success: true,
      content_html: data.content_html
    });


  } catch (error) {
    console.error("❌ Error ", err.message);
    res.status(500).json({ error: err.message });
  }

});

app.post('/check_item', async (req, res) => {
  const { checkData, gameId } = req.body;
  try {
    const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

    if (datas.length === 0) {
      res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      return;
    }

    if (checkData && checkData.length === 0) {
      res.status(500).json({ error: 'No check data found.' });
      return;
    }

    let tagId = ''

    const game = await getGameByIdAsync(gameId);

    if (game) {
      // Lưu ý: Postgres thường trả về tên cột thường. Hãy check DB nếu cột là tagId hay tagid
      tagId = game.tagId || game.tagid;
    }

    // tagId = '1552'
    const currentDate = dayjs();
    const prevDate = currentDate.subtract(30, 'day')

    const obj = JSON.parse('{"date_range": ["2025-12-23", "2026-01-21"], "search": "", "view": ["activity"], "tag26": ["136034"], "limit": 4000, "tag18": ["684110"], "init": 0, "page": 0, "category2": [], "tag37": [], "tag38": [], "tag28": []}');
    obj.date_range = [prevDate.format('YYYY-MM-DD'), currentDate.format('YYYY-MM-DD')];
    obj.tag18 = [tagId.toString()];
    obj.limit = (Math.floor(Math.random() * (5000 - 100 + 1)) + 100).toString()
    let form = new FormData();

    form.append('csrf', datas.csrf);
    form.append('plugin', 'event');
    form.append('action', 'searchItem');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj))

    console.log(form);

    let response = await axios.post('https://my.liquidandgrit.com/action/public/cms/plugin', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    let data = JSON.parse(response.data);
    // console.log(data);

    const $ = cheerio.load(data.content_html);
    const rows = $('table.table-cnd tbody tr');

    const resultData = [];
    for (let index = 0; index < checkData.length; index++) {
      const item = checkData[index];
      if(item == '') continue;

      const data = parseTrackerItem(item);

      const ret = {
        name: item,
      };

      let cnt = 0
      if (!data || !data?.startDateObj || !data?.eventName) {
        ret.url = data.url;
        cnt = 1;

      } else {
        rows.each((i, row) => {
          //console.log(i);

          const cells = $(row).find('td');

          if ($(cells[0])?.text() == data.startDateObj.format('MMMM D, YYYY')
            && $(cells[1])?.text() == data.endDateObj.format('MMMM D, YYYY')
            && $(cells[4])?.text().toLowerCase().includes(data.eventName.toLowerCase())
            && $(cells[5])?.text().toLowerCase().includes((data.subEvent || '').toLowerCase())
          ) {
            cnt++;
          } else if (cnt > 1) {
            return false; // break loop
          }
        });

        // console.log(`${data.eventName} - ${game.app_name}`);

        const result = await fetchGalleryInfo(`${data.eventName} - ${game.app_name}`, gameId);
        if (result?.id) {
          ret.url = result.permalink;
          ret.editLink = `https://my.liquidandgrit.com/admin/cms/blog/?page=8&gallery-edit-instance=${result.id}`;
        }
      }

      ret.cnt = cnt;
      ret.valid = cnt == 1;
      resultData.push(ret);
    };

    console.log(resultData);
    res.json({
      success: true,
      resultData
    });
    // res.json(Object.values(matchedRows));

  } catch (err) {
    console.error("❌ Error ", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/search-gallery', async (req, res) => {
  const { search_keyword, gameId } = req.body;
  try {
    if (!gameId) {
      res.status(500).json({ error: 'Tim theo game truoc' });
      return;
    };
    const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

    if (datas.length === 0) {
      res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
      return;
    }

    let tagId = ''

    const game = await getGameByIdAsync(gameId);

    if (game) {
      // Lưu ý: Postgres thường trả về tên cột thường. Hãy check DB nếu cột là tagId hay tagid
      tagId = game.tagId || game.tagid;
    }

    const obj = JSON.parse('{"category": [], "page": 0, "sort": ["publish_date", "desc"], "tag26": ["136034"], "tag_group_data": 1, "matrix_app_features": 0, "date_range": "", "limit": 0, "init": 0, "tag37": [], "tag38": [], "tag34": [], "tag28": [], "tag18": [], "tag29": [], "tag36": [], "tag45": [], "tag9": [], "tag42": [], "tag32": [], "tag4": [], "tag1": [], "tag2": [], "tag3": [], "tag10": [], "tag12": [], "tag7": [], "tag8": [], "tag11": [], "tag43": [], "tag13": [], "tag22": [], "tag21": [], "search": ""}');
    obj.tag18 = [tagId.toString()];
    let form = new FormData();

    form.append('csrf', datas.csrf);

    form.append('cnd_config_dir', "/cms/blog/gallery");
    form.append('config_case', "gallery");
    form.append('id', '1');
    form.append('vo-action', '');
    form.append('filter_conditions', JSON.stringify(obj))

    console.log(form);


    console.log("bat dau goi");

    let response = await axios.post('https://my.liquidandgrit.com/action/public/cms/blog/cnd', form, {
      headers: {
        Cookie: datas.cookies,
        "Content-Type": "text/html; charset=UTF-8",
      },
      responseType: "text"
    });

    let data = JSON.parse(response.data);
    // console.log(data);

    const $ = cheerio.load(data.content_html);
    const rows = $('table.view-data tbody tr');

    const matchedRows = [];

    rows.each((i, row) => {
      const link = $(row).find('td a.vo-permalink-url');
      const cells = $(row).find('td');

      // console.log(link.attr('data-info'));

      // console.log(link.attr('href'));

      if (
        (search_keyword || '') === '' ||
        $(cells[0]).text().toLowerCase().includes(search_keyword.toLowerCase()) ||
        $(cells[2]).text().toLowerCase().includes(search_keyword.toLowerCase())
      ) {
        matchedRows.push({
          title: $(cells[0]).text(),
          href: link.attr('href'),
          sub: $(cells[2]).text(),
        })
      }

      // console.log($(cells[0]).text(), $(cells[2]).text());
    });

    res.json(Object.values(matchedRows));


  } catch (err) {
    console.error("❌ Error ", err.message);
    res.status(500).json({ error: err.message });
    return;
  }
});

app.post('/get-gallery-info', async (req, res) => {
  const { galleryName, gameId } = req.body;
  try {
    if (!galleryName || !gameId) {
      res.status(500).json({ error: 'Nhập input truoc' });
      return;
    };

    const result = await fetchGalleryInfo(galleryName, gameId);

    res.json(result);

  } catch (err) {
    console.error("❌ Error ", err.message);
    res.status(500).json({ error: err.message });
    return;
  }

});

const fetchGalleryInfo = async (galleryName, gameId) => {
  const datas = fs.existsSync('cookies.json') ? JSON.parse(fs.readFileSync('cookies.json')) : [];

  if (datas.length === 0) {
    res.status(500).json({ error: 'No cookies or CSRF token found. Please login first.' });
    return;
  }

  let tagId = ''

  const game = await getGameByIdAsync(gameId);

  if (game) {
    tagId = game.tagId || game.tagid;
  }

  const obj = JSON.parse('{"limit": 10, "init": 0, "page": 0, "type": [], "status": [], "category": [], "non_category": [], "tag37": [], "tag38": [], "tag28": [], "tag34": [], "tag18": ["768367"], "tag35": [], "tag21": [], "tag29": [], "tag36": [], "tag22": [], "tag26": [], "tag45": [], "tag42": [], "tag9": [], "tag32": [], "tag4": [], "tag1": [], "tag2": [], "tag3": [], "tag10": [], "tag12": [], "tag7": [], "tag8": [], "tag11": [], "tag43": [], "tag13": [], "search": ""}');
  obj.tag18 = [tagId.toString()];
  obj.search = galleryName;

  let form = new FormData();
  form.append('csrf', datas.csrf);
  form.append('id', '1');
  form.append('vo-action', '');
  form.append('filter_conditions', JSON.stringify(obj))



  console.log("bat dau goi");

  let response = await axios.post('https://my.liquidandgrit.com/action/admin/cms/blog/post-cnd', form, {
    headers: {
      Cookie: datas.cookies,
      "Content-Type": "text/html; charset=UTF-8",
    },
    // responseType: "text"
  });

  // let data = JSON.parse(response.data);
  // console.log(response.data);

  const contentList = response.data && response.data.content ? response.data.content : [];

  const foundItem = contentList.find(item => item.name.toLowerCase() == galleryName.toLowerCase());

  return foundItem || {};


}

const calculateDateRange = (dateRangeStr) => {
  // 1. CHECK AN TOÀN: Nếu không có chuỗi hoặc không phải string -> Trả về null ngay
  if (!dateRangeStr || typeof dateRangeStr !== 'string' || !dateRangeStr.trim()) {
    return null; // Hoặc return { startDate: null, endDate: null } tùy logic của bạn
  }

  const currentDay = dayjs().date();
  const currentYear = dayjs().year();
  const currentMonth = dayjs().month() + 1; // 1-12

  const parts = dateRangeStr.split('-').map(str => str.trim());

  if (parts.length === 1) {
    // Trường hợp: "(16)" -> Start = 16, End = 16
    startStr = parts[0];
    endStr = parts[0];
  } else if (parts.length === 2) {
    // Trường hợp: "(19 - 24)"
    startStr = parts[0];
    endStr = parts[1];
  } else {
    // Trường hợp rỗng hoặc sai format
    return { startDate: null, endDate: null };
  }

  // -- XỬ LÝ END DATE --
  let endDay, endMonth, endYear = currentYear;

  if (endStr.includes('/')) {
    const splitEnd = endStr.split('/');
    endDay = parseInt(splitEnd[1]);
    endMonth = parseInt(splitEnd[0]);
  } else {
    endDay = parseInt(endStr);
    endMonth = currentMonth;
  }

  // -- XỬ LÝ START DATE --
  let startDay, startMonth = currentMonth, startYear = currentYear;

  if (startStr.includes('/')) {
    const splitStart = startStr.split('/');
    startDay = parseInt(splitStart[1]);
    startMonth = parseInt(splitStart[0]);
  } else {
    startDay = parseInt(startStr);
    // Logic: Nếu ngày bắt đầu > ngày kết thúc -> lùi 1 tháng
    if (startDay > currentDay) {
      startMonth = currentMonth - 1;
      if (startMonth === 0) {
        startMonth = 12;
        startYear -= 1;
      }
    } else {
      startMonth = currentMonth;
    }
  }

  // -- XỬ LÝ GIAO THỪA (29/12 - 1/1) --
  if (startMonth === 12 && endMonth === 1) {
    endYear = startYear + 1;
  }

  return {
    startDate: dayjs(`${startYear}-${startMonth}-${startDay}`, 'YYYY-M-D'),
    endDate: dayjs(`${endYear}-${endMonth}-${endDay}`, 'YYYY-M-D')
  };
};

/**
 * Hàm Chính: Parse log item
 */
const parseTrackerItem = (logString) => {
  if (!logString || typeof logString !== 'string') return null;

  // 1. Tách Link URL
  const parts = logString.split('|');
  let contentPart = parts[0].trim();
  let urlPart = parts[1] ? parts[1].trim() : null;

  // 2. Tìm điểm bắt đầu
  const prefixMatch = contentPart.match(/(?:for|gallery)\s+/);
  if (!prefixMatch) return null;

  let mainString = contentPart.substring(prefixMatch.index + prefixMatch[0].length).trim();

  // 3. Cắt Date (Ngoặc cuối cùng)
  const dateRegex = /\(([^)]+)\)$/;
  const dateMatch = mainString.match(dateRegex);

  let rawDate = '';
  let dates = {};
  let remaining = ''
  if (dateMatch) {
    rawDate = dateMatch[1].trim(); // Có thể là "16" hoặc "19 - 24"
    // 5. Tính toán ngày
    dates = calculateDateRange(rawDate);
    remaining = mainString.substring(0, dateMatch.index).trim();
  };

  

  // 4. Check SubEvent
  const subEventRegex = /\(([^)]+)\)$/;
  const subMatch = remaining.match(subEventRegex);

  let eventName = "";
  let subEvent = "";

  if (subMatch) {
    subEvent = subMatch[1].trim();
    eventName = remaining.substring(0, subMatch.index).trim();
  } else {
    eventName = remaining;
    subEvent = "";
  }

  return {
    eventName,
    subEvent,
    url: urlPart,
    originalDate: rawDate,
    // Format hiển thị
    startDateObj: dates.startDate,
    endDateObj: dates.endDate
  };
};

// Serve static files from React build folder
app.use(express.static(path.join(__dirname, 'build')));

// Fallback: trả về index.html với các route frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});