require("dotenv").config();
const http = require("http");
// Thay đổi ở đây: Dùng 'pg' thay vì '@neondatabase/serverless'
const { Client } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("❌ Lỗi: Thiếu DATABASE_URL trong file .env");
  process.exit(1);
}

// Cấu hình SSL cho Neon (Bắt buộc phải có ?sslmode=require)
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Chấp nhận chứng chỉ SSL của Neon
  },
});

// Kết nối 1 lần duy nhất khi bật server
client.connect()
  .then(() => console.log("✅ Đã kết nối Postgres thành công!"))
  .catch(err => console.error("❌ Lỗi kết nối ban đầu:", err));

const requestHandler = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  try {
    // Query bằng thư viện pg
    const result = await client.query('SELECT version()');
    const { version } = result.rows[0]; // Lưu ý: pg trả về trong .rows

    res.writeHead(200);
    res.end(JSON.stringify({
      status: "success",
      message: "Kết nối Database thành công! 🚀",
      postgres_version: version
    }));

  } catch (error) {
    console.error("Lỗi truy vấn:", error);
    res.writeHead(500);
    res.end(JSON.stringify({
      status: "error",
      message: "Lỗi truy vấn Database 💥",
      error_detail: error.message
    }));
  }
};

http.createServer(requestHandler).listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});