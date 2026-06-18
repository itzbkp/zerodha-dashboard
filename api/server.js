require("dotenv").config({ quiet: true });
const { neon } = require("@neondatabase/serverless");

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KITE_HOST = "api.kite.trade";

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const sql = neon(process.env.DATABASE_URL);

let ACCESS_TOKEN = "";

// Serve public files
function serveFiles(req, res) {

  const publicDir = path.join(__dirname, "..", "public");

  const filePath = path.normalize(
    path.join(publicDir, req.url === "/" ? "index.html" : req.url)
  );

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {

    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }

    const ext = path.extname(filePath);

    const contentTypes = {
      ".html": "text/html",
      ".ico": "image/x-icon",
    };

    res.writeHead(200, {
      "Content-Type":
        contentTypes[ext] ||
        "application/octet-stream",
    });

    res.end(data);
  });
}

// Generate access token
function generateAccessToken(requestToken, callback) {

  const checksum = crypto
    .createHash("sha256")
    .update(API_KEY + requestToken + API_SECRET)
    .digest("hex");

  const postData =
    `api_key=${encodeURIComponent(API_KEY)}` +
    `&request_token=${encodeURIComponent(requestToken)}` +
    `&checksum=${encodeURIComponent(checksum)}`;

  const options = {
    hostname: KITE_HOST,
    port: 443,
    path: "/session/token",
    method: "POST",

    headers: {
      "X-Kite-Version": "3",
      "Content-Type":
        "application/x-www-form-urlencoded",

      "Content-Length":
        Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (res) => {

    let body = "";

    res.on("data", (chunk) => {
      body += chunk;
    });

    res.on("end", () => {

      try {

        const parsed = JSON.parse(body);

        if (
          parsed &&
          parsed.data &&
          parsed.data.access_token
        ) {

          ACCESS_TOKEN =
            parsed.data.access_token;

          callback(null, ACCESS_TOKEN);

        } else {

          callback(parsed);
        }

      } catch (err) {

        callback(err);
      }
    });
  });

  req.on("error", (err) => {
    callback(err);
  });

  req.write(postData);
  req.end();
}

// ── Tag DB helpers ──────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(data));
}

// GET /api/tags -> { tags: [{id, name}], stockTags: { SYMBOL: [tagName, ...] } }
async function handleGetTags(req, res) {
  try {
    const [tags, rows] = await Promise.all([
      sql`SELECT id, name FROM tags ORDER BY name ASC`,
      sql`
        SELECT st.symbol, t.name
        FROM stock_tags st
        JOIN tags t ON t.id = st.tag_id
      `,
    ]);
    const stockTags = {};
    for (const row of rows) {
      if (!stockTags[row.symbol]) stockTags[row.symbol] = [];
      stockTags[row.symbol].push(row.name);
    }
    sendJson(res, 200, { tags, stockTags });
  } catch (err) {
    console.log("\n❌ GET /api/tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// POST /api/tags { name } -> create a new global tag
async function handleCreateTag(req, res) {
  try {
    const body = await readJsonBody(req);
    const name = (body.name || "").trim();
    if (!name) return sendJson(res, 400, { status: "error", message: "Tag name required" });

    const rows = await sql`
      INSERT INTO tags (name) VALUES (${name})
      ON CONFLICT (name) DO NOTHING
      RETURNING id, name
    `;
    if (rows.length === 0) {
      return sendJson(res, 409, { status: "error", message: "Tag already exists" });
    }
    sendJson(res, 200, { tag: rows[0] });
  } catch (err) {
    console.log("\n❌ POST /api/tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// PUT /api/tags/:name { newName } -> rename a tag
async function handleRenameTag(req, res, oldName) {
  try {
    const body = await readJsonBody(req);
    const newName = (body.newName || "").trim();
    if (!newName) return sendJson(res, 400, { status: "error", message: "newName required" });

    const rows = await sql`
      UPDATE tags SET name = ${newName} WHERE name = ${oldName}
      RETURNING id, name
    `;
    if (rows.length === 0) return sendJson(res, 404, { status: "error", message: "Tag not found" });
    sendJson(res, 200, { tag: rows[0] });
  } catch (err) {
    console.log("\n❌ PUT /api/tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// DELETE /api/tags/:name -> delete a tag (and its assignments via cascade)
async function handleDeleteTag(req, res, name) {
  try {
    await sql`DELETE FROM tags WHERE name = ${name}`;
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("\n❌ DELETE /api/tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// POST /api/stock-tags { symbol, tag } -> assign tag to stock
async function handleAssignStockTag(req, res) {
  try {
    const body = await readJsonBody(req);
    const symbol = (body.symbol || "").trim();
    const tag = (body.tag || "").trim();
    if (!symbol || !tag) return sendJson(res, 400, { status: "error", message: "symbol and tag required" });

    const tagRows = await sql`SELECT id FROM tags WHERE name = ${tag}`;
    if (tagRows.length === 0) return sendJson(res, 404, { status: "error", message: "Tag not found" });

    await sql`
      INSERT INTO stock_tags (symbol, tag_id) VALUES (${symbol}, ${tagRows[0].id})
      ON CONFLICT (symbol, tag_id) DO NOTHING
    `;
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("\n❌ POST /api/stock-tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// DELETE /api/stock-tags { symbol, tag } -> unassign tag from stock
async function handleUnassignStockTag(req, res) {
  try {
    const body = await readJsonBody(req);
    const symbol = (body.symbol || "").trim();
    const tag = (body.tag || "").trim();
    if (!symbol || !tag) return sendJson(res, 400, { status: "error", message: "symbol and tag required" });

    const tagRows = await sql`SELECT id FROM tags WHERE name = ${tag}`;
    if (tagRows.length === 0) return sendJson(res, 404, { status: "error", message: "Tag not found" });

    await sql`DELETE FROM stock_tags WHERE symbol = ${symbol} AND tag_id = ${tagRows[0].id}`;
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("\n❌ DELETE /api/stock-tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// POST /api/cleanup { symbols: [...] } -> remove stock_tags rows for symbols not in the given list
async function handleCleanup(req, res) {
  try {
    const body = await readJsonBody(req);
    const symbols = Array.isArray(body.symbols) ? body.symbols.filter(Boolean) : [];
    if (symbols.length === 0) {
      return sendJson(res, 400, { status: "error", message: "symbols array required" });
    }

    const deleted = await sql`
      DELETE FROM stock_tags
      WHERE symbol <> ALL(${symbols})
      RETURNING symbol
    `;

    sendJson(res, 200, { status: "ok", removedCount: deleted.length, removedSymbols: deleted.map(r => r.symbol) });
  } catch (err) {
    console.log("\n❌ POST /api/cleanup ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// Create HTTP server
const server = http.createServer((req, res) => {

  console.log(`${req.method} ${req.url}`);

  // CORS
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Tag API routes ──────────────────────────────────
  const parsedForTags = new URL(req.url, "http://placeholder.local");
  const tagPathname = parsedForTags.pathname;

  if (tagPathname === "/api/tags" && req.method === "GET") {
    return handleGetTags(req, res);
  }

  if (tagPathname === "/api/tags" && req.method === "POST") {
    return handleCreateTag(req, res);
  }

  if (tagPathname.startsWith("/api/tags/") && req.method === "PUT") {
    const oldName = decodeURIComponent(tagPathname.slice("/api/tags/".length));
    return handleRenameTag(req, res, oldName);
  }

  if (tagPathname.startsWith("/api/tags/") && req.method === "DELETE") {
    const name = decodeURIComponent(tagPathname.slice("/api/tags/".length));
    return handleDeleteTag(req, res, name);
  }

  if (tagPathname === "/api/stock-tags" && req.method === "POST") {
    return handleAssignStockTag(req, res);
  }

  if (tagPathname === "/api/stock-tags" && req.method === "DELETE") {
    return handleUnassignStockTag(req, res);
  }

  if (tagPathname === "/api/cleanup" && req.method === "POST") {
    return handleCleanup(req, res);
  }

  // Static routes
  if (
    req.url === "/" ||
    path.extname(req.url)
  ) {

    serveFiles(req, res);
    return;
  }

  // Login route
  if (req.url === "/login") {

    const loginUrl =
      `https://kite.trade/connect/login?v=3&api_key=${API_KEY}`;

    res.writeHead(302, {
      Location: loginUrl,
    });

    res.end();
    return;
  }

  // Callback route
  if (req.url.startsWith("/callback")) {

    const parsedUrl = new URL(req.url, "http://placeholder.local");

    const requestToken =
      parsedUrl.searchParams.get("request_token");

    if (!requestToken) {

      res.writeHead(400, {
        "Content-Type": "text/plain",
      });

      res.end("Missing request_token");

      return;
    }

    generateAccessToken(
      requestToken,
      (err, token) => {

        if (err) {

          console.log("\n❌ TOKEN ERROR:");
          console.log(err);

          res.writeHead(500, {
            "Content-Type": "application/json",
          });

          res.end(JSON.stringify(err));

          return;
        }

        res.writeHead(302, {
          Location: "/",
        }).end();
      }
    );

    return;
  }

  // Require login first
  if (!ACCESS_TOKEN) {

    res.writeHead(401, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify({
      status: "Login-Required"
    }));

    return;
  }

  // Proxy request to Zerodha
  const options = {

    hostname: KITE_HOST,
    port: 443,

    path: req.url,

    method: req.method,

    headers: {

      "X-Kite-Version": "3",

      "Authorization":
        `token ${API_KEY}:${ACCESS_TOKEN}`,

      "Content-Type": "application/json",

      "Host": KITE_HOST,
    },
  };

  const proxy =
    https.request(options, (kiteRes) => {

      let body = "";

      kiteRes.on("data", (chunk) => {
        body += chunk;
      });

      kiteRes.on("end", () => {

        res.writeHead(
          kiteRes.statusCode,
          {
            "Content-Type": "application/json",
          }
        );

        res.end(body);
      });
    });

  proxy.on("error", (err) => {

    console.log("\n❌ PROXY ERROR:");
    console.log(err);

    res.writeHead(502, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify({
      status: "error",
      message: err.message,
    }));
  });

  req.pipe(proxy);
});

module.exports = server;