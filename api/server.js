require("dotenv").config({ quiet: true });
const { Resend } = require("resend");
const { flagsClient } = require("@vercel/flags-core");
const { neon } = require("@neondatabase/serverless");
const { QuillDeltaToHtmlConverter } = require("quill-delta-to-html");
const YahooFinance = require("yahoo-finance2").default;
const MOCK_HOLDINGS = require("./mock-holdings.json");

const http = require("http");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const KITE_HOST = "api.kite.trade";

const MOCK_DATA = "MOCK_DATA";

const sql = neon(process.env.DATABASE_URL);

const resend = new Resend(process.env.RESEND_API_KEY);

const activeRoutes = ["/api/forward", "/api/confirmation"];

async function isOfflineMode() {
  try {
    const result = await flagsClient.evaluate("offline-mode", false);
    return result.value;
  } catch (err) {
    console.log("⚠️  Unable to fetch the offline-mode flag:", err.message);
    return false;
  }
}

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zerodha Dashboard — Offline</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #111111;
        color: #d4d4d4;
        font-family: -apple-system, "Inter", sans-serif;
      }
      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }
      .card {
        text-align: center;
        padding: 40px 48px;
        border: 1px solid #4a4a4a;
        border-radius: 14px;
        background: #161616;
        max-width: 420px;
      }
      .status {
        border: 1px solid #4a4a4a;
        border-radius: 20px;
        margin: auto;
        padding: 6px 14px;
        width: fit-content;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #f08a00;
        display: inline-block;
        margin-right: 8px;
        animation: pulse 2s infinite;
      }
      h1 {
        font-size: 20px;
        margin: 16px 0 8px;
      }
      p {
        color: #8a8a8a;
        font-size: 14px;
        line-height: 1.5;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="status"><span class="dot"></span><strong>Offline</strong></div>
      <h1>We'll be back soon</h1>
      <p>
        The dashboard is currently undergoing scheduled maintenance. Please
        check back shortly.
      </p>
    </div>
  </body>
</html>
`;

// ── Market hours check (NSE/BSE) ────────────────────
function isIndianMarketOpen() {
  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const day = nowIST.getDay();
  if (day === 0 || day === 6) return false;

  const minutesNow = nowIST.getHours() * 60 + nowIST.getMinutes();
  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;
  return minutesNow >= marketOpen && minutesNow < marketClose;
}

// ── Yahoo Finance live-quote enrichment ─────────────
function yahooSymbolFor(holding) {
  const suffix = holding.exchange === "BSE" ? ".BO" : ".NS";
  return `${holding.tradingsymbol}${suffix}`;
}

async function enrichWithLiveQuotes(holdings, isStubbed) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;

  if (!isIndianMarketOpen() && !isStubbed) {
    return holdings;
  }

  const yahooSymbols = holdings.map(yahooSymbolFor);

  let quoteMap = {};
  try {

    quoteMap = await yahooFinance.quote(yahooSymbols, { return: "object" });
  } catch (err) {
    console.log("⚠️  Unable to fetch live quotes from Yahoo Finance:", err.message);
    holdings.status = "error";
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

async function uploadImagesToImgBB(html) {
  const regex = /<img([^>]+)src="data:(image\/[^;]+);base64,([^"]+)"([^>]*)>/g;
  const matches = [...html.matchAll(regex)];

  for (const match of matches) {
    const [fullMatch, before, mime, base64, after] = match;

    if (!["image/png", "image/jpeg", "image/heic", "image/heif"].includes(mime))
      throw new Error("Invalid image type");

    if (Buffer.byteLength(base64, "base64") > 2 * 1024 * 1024)
      throw new Error("Image size exceeds 2 MB");

    const formData = new FormData();
    formData.append("image", base64);

    const res = await fetch("https://api.imgbb.com/1/upload?key=" + process.env.IMGBB_API_KEY, {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    if (!data.success)
      throw new Error("Image upload failed");

    html = html.replace(fullMatch, `<img${before}src="${data.data.url}"${after}>`);
  }

  return html;
}

function sendEmail(templateId, email, variables) {
  return resend.emails.send(
    {
      to: email,
      replyTo: templateId === "support" ? variables.email : undefined,
      template: {
        id: templateId,
        variables,
      },
    }
  );
}

function serveFiles(req, res) {

  const publicDir = path.join(__dirname, "..", "public");
  const assetsDir = path.join(publicDir, "assets");

  const requestedPath = req.url === "/" ? "index.html" : req.url;

  const filePath = path.normalize(
    requestedPath === "index.html"
      ? path.join(publicDir, "index.html")
      : path.join(assetsDir, requestedPath)
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
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };

    res.writeHead(200, {
      "Content-Type":
        contentTypes[ext] ||
        "application/octet-stream",
    });

    res.end(data);
  });
}

// ── Cookie / session helpers ─────────────────────────
function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies["kite_session"];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function isLocalhost(req) {
  const host = (req.headers.host || "").split(":")[0];
  return host === "localhost";
}

async function getUserCredentials(userId, req) {
  if (!userId) return null;
  try {
    const rows = await sql`SELECT api_key, api_secret FROM users WHERE id = ${userId}`;
    return rows[0] ? isLocalhost(req) ? {
      api_key: process.env.API_KEY,
      api_secret: process.env.API_SECRET,
    } : rows[0] : null;
  } catch (err) {
    console.log("❌ getUserCredentials DB ERROR:");
    console.log(err.message);
    return null;
  }
}

function generateAccessToken(apiKey, apiSecret, requestToken, callback) {

  const checksum = crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");

  const postData =
    `api_key=${encodeURIComponent(apiKey)}` +
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

          callback(null, parsed.data.access_token);

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

function promptLoginRequired(res, message) {
  console.log("❌ " + message);
  sendJson(res, 401, { status: "Login-Required" });
}

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

async function handleGetTags(res, userId) {
  try {
    const [tags, rows] = await Promise.all([
      sql`SELECT id, name FROM tags WHERE user_id = ${userId} ORDER BY name ASC`,
      sql`
        SELECT st.symbol, t.name
        FROM stock_tags st
        JOIN tags t ON t.id = st.tag_id
        WHERE st.user_id = ${userId}
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
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleCreateTag(req, res, userId) {
  try {
    if (userId === MOCK_DATA) return sendJson(res, 401, { status: "error", message: "Buy this dashboard to manage your tags" });

    const body = await readJsonBody(req);
    const name = (body.name || "").trim();
    if (!name) return sendJson(res, 400, { status: "error", message: "Tag name required" });

    const rows = await sql`
      INSERT INTO tags (name, user_id) VALUES (${name}, ${userId})
      ON CONFLICT (user_id, name) DO NOTHING
      RETURNING id, name
    `;
    if (rows.length === 0) {
      return sendJson(res, 409, { status: "error", message: "Tag already exists" });
    }
    sendJson(res, 200, { tag: rows[0] });
  } catch (err) {
    console.log("❌ POST /api/tags ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleRenameTag(req, res, oldName, userId) {
  try {
    if (userId === MOCK_DATA) return sendJson(res, 401, { status: "error", message: "Buy this dashboard to manage your tags" });

    const body = await readJsonBody(req);
    const newName = (body.newName || "").trim();
    if (!newName) return sendJson(res, 400, { status: "error", message: "newName required" });

    const rows = await sql`
      UPDATE tags SET name = ${newName} WHERE name = ${oldName} AND user_id = ${userId}
      RETURNING id, name
    `;
    if (rows.length === 0) return sendJson(res, 404, { status: "error", message: "Tag not found" });
    sendJson(res, 200, { tag: rows[0] });
  } catch (err) {
    console.log("❌ PUT /api/tags ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleDeleteTag(res, name, userId) {
  try {
    if (userId === MOCK_DATA) return sendJson(res, 401, { status: "error", message: "Buy this dashboard to manage your tags" });

    await sql`DELETE FROM tags WHERE name = ${name} AND user_id = ${userId}`;
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ DELETE /api/tags ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleAssignStockTag(req, res, userId) {
  try {
    if (userId === MOCK_DATA) return sendJson(res, 401, { status: "error", message: "Buy this dashboard to manage your tags" });

    const body = await readJsonBody(req);
    const symbol = (body.symbol || "").trim();
    const tag = (body.tag || "").trim();
    if (!symbol || !tag) return sendJson(res, 400, { status: "error", message: "symbol and tag required" });

    const tagRows = await sql`SELECT id FROM tags WHERE name = ${tag} AND user_id = ${userId}`;
    if (tagRows.length === 0) return sendJson(res, 404, { status: "error", message: "Tag not found" });

    await sql`
      INSERT INTO stock_tags (symbol, tag_id, user_id) VALUES (${symbol}, ${tagRows[0].id}, ${userId})
      ON CONFLICT (user_id, symbol, tag_id) DO NOTHING
    `;
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ POST /api/stock-tags ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleUnassignStockTag(req, res, userId) {
  try {
    if (userId === MOCK_DATA) return sendJson(res, 401, { status: "error", message: "Buy this dashboard to manage your tags" });

    const body = await readJsonBody(req);
    const symbol = (body.symbol || "").trim();
    const tag = (body.tag || "").trim();
    if (!symbol || !tag) return sendJson(res, 400, { status: "error", message: "symbol and tag required" });

    const tagRows = await sql`SELECT id FROM tags WHERE name = ${tag} AND user_id = ${userId}`;
    if (tagRows.length === 0) return sendJson(res, 404, { status: "error", message: "Tag not found" });

    await sql`DELETE FROM stock_tags WHERE symbol = ${symbol} AND tag_id = ${tagRows[0].id} AND user_id = ${userId}`;
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ DELETE /api/stock-tags ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleCleanup(req, res, userId) {
  try {
    if (userId === MOCK_DATA) return sendJson(res, 200, { status: "ok", removedCount: 0, removedSymbols: [] });

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
      WHERE user_id = ${userId} AND symbol <> ALL(${protectedSymbols})
      RETURNING symbol
    `;
    console.log("✅ Cleanup Results:", deleted.length, deleted.map(r => r.symbol));
    sendJson(res, 200, { status: "ok", removedCount: deleted.length, removedSymbols: deleted.map(r => r.symbol) });
  } catch (err) {
    console.log("❌ POST /api/cleanup ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleConfirmation(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = (body.email || "").trim();
    const name = (body.name || "").trim();
    const userId = (body.userId || "").trim();
    if (!email || !name || !userId) {
      return sendJson(res, 400, { status: "error", message: "email, name and userId required" });
    }

    await sendEmail("confirmation", email, { name, userId });
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ POST /api/confirmation ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleSignup(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = (body.email || "").trim();
    const name = (body.name || "").trim();
    const userId = (body.userId || "").trim();
    if (!email || !name || !userId) {
      return sendJson(res, 400, { status: "error", message: "email, name and userId required" });
    }

    await sql`INSERT INTO customers (email, full_name, user_id) VALUES (${email}, ${name}, ${userId})`;
    await sendEmail("welcome", email, { name });
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ POST /api/signup ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleSupport(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = (body.email || "").trim();
    const name = (body.name || "").trim();
    const delta = body.query;
    if (!email || !name || !delta)
      return sendJson(res, 400, { status: "error", message: "email, name and query required" });
    const query = await uploadImagesToImgBB(new QuillDeltaToHtmlConverter(delta.ops || [], {
      inlineStyles: {
        font: (font) => `font-family:${font}`,
        size: {
          small: "font-size:0.75em",
          large: "font-size:1.5em",
          huge: "font-size:2.5em"
        },
        color: (color) => `color:${color}`,
        background: (bg) => `background-color:${bg}`,
        align: (align) => `text-align:${align}`,
        direction: (value, op) => {
          if (value === "rtl") {
            return "direction:rtl;text-align:inherit";
          }
        },
        indent: (value, op) => {
          const side = op.attributes.direction === "rtl" ? "right" : "left";
          return `padding-${side}:${value * 3}em`;
        }
      }
    }).convert());

    await sendEmail("support", process.env.SUPPORT_EMAIL, { email, name, query });
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ POST /api/support ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

async function handleForward(req, res) {
  try {
    const body = await readJsonBody(req);
    const from = (body.data.from || "").trim();
    const to = body.data.to[0];
    const subject = (body.data.subject || "").trim();
    const emailId = (body.data.email_id || "").trim();

    const { data } = await resend.emails.receiving.get(emailId);
    const { data: attachmentList } = await resend.emails.receiving.attachments.list({ emailId });
    const attachments = await Promise.all(
      (attachmentList?.data || [])
        .filter((a) => a.content_disposition === "attachment")
        .map(async (a) => {
          const fileRes = await fetch(a.download_url);
          const buf = Buffer.from(await fileRes.arrayBuffer());
          return { filename: a.filename, content: buf.toString("base64") };
        })
    );

    await resend.emails.send({
      from: to,
      to: process.env.SUPPORT_EMAIL,
      replyTo: from,
      subject,
      html: await uploadImagesToImgBB(data.html) || `<pre>${data.text}</pre>`,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    sendJson(res, 200, { status: "ok" });
  } catch (err) {
    console.log("❌ POST /api/forward ERROR:");
    console.log(err.message);
    sendJson(res, 500, { status: "error", message: err.message });
  }
}

let loggingFlag = false;

const server = http.createServer(async (req, res) => {

  const requestStartedAt = Date.now();
  const session = getSession(req);

  res.on("finish", () => {
    const elapsedMs = Date.now() - requestStartedAt;
    const statusCode = ["/portfolio/holdings", "/user/profile"].includes(req.url) && !session ? 304 : res.statusCode;
    const isHoldingsRoute = req.url === "/portfolio/holdings" && statusCode < 400;
    if (isHoldingsRoute && loggingFlag) return;
    console.log(`${req.method} ${req.url} → ${statusCode} (${elapsedMs}ms)`);
    loggingFlag = isHoldingsRoute;
  });

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

  const userId = (session && session.user_id) || MOCK_DATA;

  const parsedRouteUrl = new URL(req.url, "http://placeholder.local");

  // ── Tag API routes ──────────────────────────────────
  const parsedForTags = new URL(req.url, "http://placeholder.local");
  const pathname = parsedForTags.pathname;

  if (!activeRoutes.includes(pathname)) {
    const isOffline = await isOfflineMode();
    if (isOffline) {
      if (pathname === "/") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end(OFFLINE_HTML);
        return;
      }
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Service temporarily unavailable.");
      return;
    }
  }

  if (pathname === "/api/tags" && req.method === "GET") {
    return handleGetTags(res, userId);
  }

  const isTagAmendmentRoute =
    (pathname === "/api/tags" && req.method === "POST") ||
    (pathname.startsWith("/api/tags/") && (req.method === "PUT" || req.method === "DELETE")) ||
    (pathname === "/api/stock-tags" && (req.method === "POST" || req.method === "DELETE"));

  if (isTagAmendmentRoute && !session) {
    return sendJson(res, 403, { status: "error", message: "Buy this dashboard to manage your tags" });
  }

  if (pathname === "/api/tags" && req.method === "POST") {
    return handleCreateTag(req, res, userId);
  }

  if (pathname.startsWith("/api/tags/") && req.method === "PUT") {
    const oldName = decodeURIComponent(pathname.slice("/api/tags/".length));
    return handleRenameTag(req, res, oldName, userId);
  }

  if (pathname.startsWith("/api/tags/") && req.method === "DELETE") {
    const name = decodeURIComponent(pathname.slice("/api/tags/".length));
    return handleDeleteTag(res, name, userId);
  }

  if (pathname === "/api/stock-tags" && req.method === "POST") {
    return handleAssignStockTag(req, res, userId);
  }

  if (pathname === "/api/stock-tags" && req.method === "DELETE") {
    return handleUnassignStockTag(req, res, userId);
  }

  if (pathname === "/api/cleanup" && req.method === "POST") {
    return handleCleanup(req, res, userId);
  }

  if (pathname === "/api/confirmation" && req.method === "POST") {
    return handleConfirmation(req, res);
  }

  if (pathname === "/api/signup" && req.method === "POST") {
    return handleSignup(req, res);
  }

  if (pathname === "/api/support" && req.method === "POST") {
    return handleSupport(req, res);
  }

  if (pathname === "/api/forward" && req.method === "POST") {
    return handleForward(req, res);
  }

  if (pathname === "/portfolio/holdings" && req.method === "GET" && !session) {
    const mockHoldings = await enrichWithLiveQuotes(MOCK_HOLDINGS, true);
    return sendJson(res, 200, {
      status: mockHoldings.status || "success",
      isStubbed: true,
      marketOpen: isIndianMarketOpen(),
      data: mockHoldings,
    });
  }

  if (pathname === "/user/profile" && req.method === "GET" && !session) {
    return sendJson(res, 200, {
      status: "success",
      data: {
        isStubbed: true,
        user_id: "",
        avatar_url: "https://s3.ap-south-1.amazonaws.com/zerodha-kite-blobs/avatars/zYRMQSdS4xxhhTeGgtzK5pfeAQY8Vfr0.png",
        full_name: "Barun Patro",
        cash: 0,
      },
    });
  }

  if (
    req.url === "/" ||
    path.extname(req.url)
  ) {

    serveFiles(req, res);
    return;
  }

  if (req.url === "/api/user" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const userId = (body.user_id || "").trim();

      if (!userId) {
        console.log("❌ POST /api/user ERROR:");
        console.log("Missing user_id in session");

        sendJson(res, 400, { status: "error", message: "Missing user_id in session" });
        return;
      }

      const creds = await getUserCredentials(userId, req);

      if (!creds) {
        console.log("❌ POST /api/user ERROR:");
        console.log("User not found");

        sendJson(res, 404, { status: "error", message: "User not found" });
        return;
      }

      const cookieValue = JSON.stringify({ user_id: userId });
      const cookieFlags = [
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=315360000",
      ];
      if (!isLocalhost(req)) cookieFlags.push("Secure");

      res.setHeader(
        "Set-Cookie",
        `kite_session=${encodeURIComponent(cookieValue)}; ${cookieFlags.join("; ")}`
      );

      sendJson(res, 200, { status: "ok" });
      return;
    } catch (err) {
      console.log("❌ POST /api/user ERROR:");
      console.log(err.message);

      sendJson(res, 500, { status: "error", message: err.message });
      return;
    }
  }

  if (req.url === "/login") {

    const creds = await getUserCredentials(userId, req);

    if (!creds) {
      console.log("❌ GET /login ERROR:");
      console.log("User not found");

      sendJson(res, 404, { status: "error", message: "User not found" });
      return;
    }

    const loginUrl =
      `https://kite.trade/connect/login?v=3&api_key=${creds.api_key}`;

    res.writeHead(302, {
      Location: loginUrl,
    });

    res.end();
    return;
  }

  if (req.url === "/logout") {

    const cookieFlags = [
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ];
    if (!isLocalhost(req)) cookieFlags.push("Secure");

    res.setHeader(
      "Set-Cookie",
      `kite_session=; ${cookieFlags.join("; ")}`
    );

    res.writeHead(302, {
      Location: "/",
    });

    res.end();
    return;
  }

  if (req.url.startsWith("/callback")) {

    const parsedUrl = new URL(req.url, "http://placeholder.local");

    const requestToken =
      parsedUrl.searchParams.get("request_token");

    if (!requestToken) {

      sendJson(res, 400, { status: "error", message: "Missing request_token" });
      return;
    }

    const creds = await getUserCredentials(userId, req);

    if (!creds) {
      console.log("❌ POST /callback ERROR:");
      console.log("User not found");

      sendJson(res, 404, { status: "error", message: "User not found" });
      return;
    }

    generateAccessToken(
      creds.api_key,
      creds.api_secret,
      requestToken,
      (err, token) => {

        if (err) {

          console.log("❌ TOKEN ERROR:");
          console.log(err.message);

          sendJson(res, 400, { status: "error", message: err.message });
          return;
        }

        const cookieValue = JSON.stringify({
          user_id: userId,
          api_key: creds.api_key,
          access_token: token,
        });
        const cookieFlags = [
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          "Max-Age=315360000",
        ];
        if (!isLocalhost(req)) cookieFlags.push("Secure");

        res.setHeader(
          "Set-Cookie",
          `kite_session=${encodeURIComponent(cookieValue)}; ${cookieFlags.join("; ")}`
        );

        res.writeHead(302, {
          Location: "/",
        })
        res.end();
      }
    );

    return;
  }

  if (!session?.access_token) {
    return promptLoginRequired(res, "Missing access_token in session");
  }
  else if (!session?.api_key) {
    return promptLoginRequired(res, "Missing api_key in session");
  }

  const options = {

    hostname: KITE_HOST,
    port: 443,

    path: req.url,

    method: req.method,

    headers: {

      "X-Kite-Version": "3",

      "Authorization":
        `token ${session.api_key}:${session.access_token}`,

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

        try {
          const response = JSON.parse(body);

          if (
            response?.status === "error" &&
            response?.error_type === "TokenException" || response?.error_type === "PermissionException"
          ) {

            return promptLoginRequired(res, "Zerodha: " + response?.message);
          }

          const isHoldingsRoute = parsedRouteUrl.pathname === "/portfolio/holdings";
          const isProfileRoute = parsedRouteUrl.pathname === "/user/profile";

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
            response.marketOpen = isIndianMarketOpen();

            sendJson(res, kiteRes.statusCode, response);
            return;
          }

          if (
            isProfileRoute &&
            response?.status === "success" &&
            response.data
          ) {
            const userRows = await sql`SELECT full_name FROM users WHERE id = ${session.user_id}`;

            let cash = 0;
            try {
              const res = await fetch(req.headers.referer + "user/margins/equity", {
                headers: req.headers
              });
              const json = await res.json();
              cash = json?.data?.net || 0;
            } catch (err) {
              console.log("⚠️  Unable to fetch Kite margins:", err.message);
            }

            sendJson(res, kiteRes.statusCode, {
              status: "success",
              data: {
                user_id: response.data.user_id,
                avatar_url: response.data.avatar_url,
                full_name: userRows[0]?.full_name || null,
                cash,
              },
            });
            return;
          }

          sendJson(res, kiteRes.statusCode, response);
        } catch (err) {
          console.log(`❌ ${req.method} ${parsedRouteUrl.pathname} ERROR:`);
          console.log(err.message);

          sendJson(res, 500, { status: "error", message: err.message });
          return;
        }
      });
    });

  proxy.on("error", (err) => {

    console.log("❌ PROXY ERROR:");
    console.log(err.message);

    sendJson(res, 502, {
      status: "error",
      message: err.message,
    });
  });

  req.pipe(proxy);
});

module.exports = server;