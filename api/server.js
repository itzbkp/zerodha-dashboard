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

const MOCK_DATA = "MOCK_DATA";

const sql = neon(process.env.DATABASE_URL);

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

const server = http.createServer(async (req, res) => {

  const requestStartedAt = Date.now();
  const session = getSession(req);

  res.on("finish", () => {
    const elapsedMs = Date.now() - requestStartedAt;
    const statusCode = ["/portfolio/holdings", "/user/profile"].includes(req.url) && !session ? 304 : res.statusCode;
    console.log(`${req.method} ${req.url} → ${statusCode} (${elapsedMs}ms)`);
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
  const tagPathname = parsedForTags.pathname;

  if (tagPathname === "/api/tags" && req.method === "GET") {
    return handleGetTags(res, userId);
  }

  const isTagAmendmentRoute =
    (tagPathname === "/api/tags" && req.method === "POST") ||
    (tagPathname.startsWith("/api/tags/") && (req.method === "PUT" || req.method === "DELETE")) ||
    (tagPathname === "/api/stock-tags" && (req.method === "POST" || req.method === "DELETE"));

  if (isTagAmendmentRoute && !session) {
    return sendJson(res, 403, { status: "error", message: "Buy this dashboard to manage your tags" });
  }

  if (tagPathname === "/api/tags" && req.method === "POST") {
    return handleCreateTag(req, res, userId);
  }

  if (tagPathname.startsWith("/api/tags/") && req.method === "PUT") {
    const oldName = decodeURIComponent(tagPathname.slice("/api/tags/".length));
    return handleRenameTag(req, res, oldName, userId);
  }

  if (tagPathname.startsWith("/api/tags/") && req.method === "DELETE") {
    const name = decodeURIComponent(tagPathname.slice("/api/tags/".length));
    return handleDeleteTag(res, name, userId);
  }

  if (tagPathname === "/api/stock-tags" && req.method === "POST") {
    return handleAssignStockTag(req, res, userId);
  }

  if (tagPathname === "/api/stock-tags" && req.method === "DELETE") {
    return handleUnassignStockTag(req, res, userId);
  }

  if (tagPathname === "/api/cleanup" && req.method === "POST") {
    return handleCleanup(req, res, userId);
  }

  if (tagPathname === "/portfolio/holdings" && req.method === "GET" && !session) {
    const mockHoldings = await enrichWithLiveQuotes(MOCK_HOLDINGS, true);
    return sendJson(res, 200, {
      status: mockHoldings.status || "success",
      isStubbed: true,
      marketOpen: isIndianMarketOpen(),
      data: mockHoldings,
    });
  }

  if (tagPathname === "/user/profile" && req.method === "GET" && !session) {
    return sendJson(res, 200, {
      status: "success",
      data: {
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

          // ── Live-quote enrichment for holdings, trimmed profile merge ──
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