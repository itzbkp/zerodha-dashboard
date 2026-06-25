require("dotenv").config({ quiet: true });
const { neon } = require("@neondatabase/serverless");
const YahooFinance = require("yahoo-finance2").default;
const MOCK_HOLDINGS = require("./mock-holdings.json");

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const KITE_HOST = "api.kite.trade";

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const sql = neon(process.env.DATABASE_URL);

let ACCESS_TOKEN = "";
const mockHoldings = false;

// ── Market hours check (NSE/BSE) ────────────────────
function isIndianMarketOpen() {
  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const day = nowIST.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const minutesNow = nowIST.getHours() * 60 + nowIST.getMinutes();
  const marketOpen = 9 * 60 + 15; // 9:15 AM
  const marketClose = 15 * 60 + 30; // 3:30 PM
  return minutesNow >= marketOpen && minutesNow <= marketClose;
}

// ── Yahoo Finance live-quote enrichment ─────────────
function yahooSymbolFor(holding) {
  const suffix = holding.exchange === "BSE" ? ".BO" : ".NS";
  return `${holding.tradingsymbol}${suffix}`;
}

async function enrichWithLiveQuotes(holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;

  if (!isIndianMarketOpen() && !mockHoldings) {
    return holdings;
  }

  const yahooSymbols = holdings.map(yahooSymbolFor);

  let quoteMap = {};
  try {

    quoteMap = await yahooFinance.quote(yahooSymbols, { return: "object" });
  } catch (err) {
    // Whole batch call failed (network, rate limit, etc) — just
    // return the original Kite data untouched.
    console.log("⚠️  Yahoo Finance batch quote failed:", err.message);
    return holdings;
  }

  return holdings.map((h) => {
    const ySym = yahooSymbolFor(h);
    const q = quoteMap[ySym];

    if (!q || typeof q.regularMarketPrice !== "number") return h;

    const lastPrice = q.regularMarketPrice;
    const dayChange =
      typeof q.regularMarketChange === "number" ? q.regularMarketChange : h.day_change;
    const dayChangePct =
      typeof q.regularMarketChangePercent === "number"
        ? q.regularMarketChangePercent
        : h.day_change_percentage;

    return {
      ...h,
      last_price: lastPrice,
      day_change: dayChange,
      day_change_percentage: dayChangePct,
      pnl: (lastPrice - h.average_price) * h.quantity,
    };
  });
}

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

// Prompt for Login 
function promptLoginRequired(res, message) {
  console.log("❌ " + message);

  res.writeHead(401, {
    "Content-Type": "application/json",
  });

  res.end(JSON.stringify({
    status: "Login-Required"
  }));
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
    console.log("❌ GET /api/tags ERROR:");
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
    console.log("❌ POST /api/tags ERROR:");
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
    console.log("❌ PUT /api/tags ERROR:");
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
    console.log("❌ DELETE /api/tags ERROR:");
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
    console.log("❌ POST /api/stock-tags ERROR:");
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
    console.log("❌ DELETE /api/stock-tags ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// POST /api/cleanup { symbols: [...] } -> remove stock_tags rows for symbols not in the given list
async function handleCleanup(req, res) {
  try {
    if (mockHoldings) {
      console.log("⚠️  Cleanup not required");
      return sendJson(res, 200, { status: "ok", removedCount: 0, removedSymbols: [] });
    }
    const body = await readJsonBody(req);
    const symbols = Array.isArray(body.symbols) ? body.symbols.filter(Boolean) : [];
    if (symbols.length === 0) {
      return sendJson(res, 400, { status: "error", message: "symbols array required" });
    }

    const protectedSymbols = symbols.includes("LIQUIDCASE")
      ? symbols
      : [...symbols, "LIQUIDCASE"];

    const deleted = await sql`
      DELETE FROM stock_tags
      WHERE symbol <> ALL(${protectedSymbols})
      RETURNING symbol
    `;
    console.log("✅ Cleanup Results:", deleted.length, deleted.map(r => r.symbol));
    sendJson(res, 200, { status: "ok", removedCount: deleted.length, removedSymbols: deleted.map(r => r.symbol) });
  } catch (err) {
    console.log("❌ POST /api/cleanup ERROR:");
    console.log(err);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {

  const requestStartedAt = Date.now();

  res.on("finish", () => {
    const elapsedMs = Date.now() - requestStartedAt;
    const statusCode = ["/portfolio/holdings", "/user/profile"].includes(req.url) && mockHoldings ? 304 : res.statusCode;
    console.log(`${req.method} ${req.url} → ${statusCode} (${elapsedMs}ms)`);
  });

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

  if (tagPathname === "/portfolio/holdings" && req.method === "GET" && mockHoldings) {
    const mockHoldings = await enrichWithLiveQuotes(MOCK_HOLDINGS);
    return sendJson(res, 200, {
      status: "success",
      isStubbed: true,
      data: mockHoldings,
    });
  }

  if (tagPathname === "/user/profile" && req.method === "GET" && mockHoldings) {
    return sendJson(res, 200, {
      status: "success",
      data: {
        avatar_url: "https://s3.ap-south-1.amazonaws.com/zerodha-kite-blobs/avatars/zYRMQSdS4xxhhTeGgtzK5pfeAQY8Vfr0.png",
      },
    });
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

          console.log("❌ TOKEN ERROR:");
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

    return promptLoginRequired(res, "Access token is required");
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

      kiteRes.on("end", async () => {

        const response = JSON.parse(body);

        if (
          response?.status === "error" &&
          response?.error_type === "TokenException"
        ) {

          return promptLoginRequired(res, response?.message);
        }

        // ── Live-quote enrichment for holdings only ──────────────
        const parsedHoldingsUrl = new URL(req.url, "http://placeholder.local");
        const isHoldingsRoute = parsedHoldingsUrl.pathname === "/portfolio/holdings"

        if (
          isHoldingsRoute &&
          response?.status === "success" &&
          Array.isArray(response.data)
        ) {
          try {
            response.data = await enrichWithLiveQuotes(response.data);
          } catch (err) {
            console.log(
              "⚠️  Unable to fetch live quotes from Yahoo Finance, hence serving from Kite:",
              err.message
            );
          }

          res.writeHead(kiteRes.statusCode, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(response));
          return;
        }

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

    console.log("❌ PROXY ERROR:");
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