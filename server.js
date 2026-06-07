require("dotenv").config({ quiet: true });

const http = require("http");
const https = require("https");
const fs = require("fs");
const url = require("url");
const path = require("path");
const crypto = require("crypto");

const KITE_HOST = "api.kite.trade";

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

let ACCESS_TOKEN = "";

// Serve index.html
function serveIndex(res) {

  const filePath = path.resolve(__dirname, "index.html");

  fs.readFile(filePath, (err, data) => {

    if (err) {
      console.error(err);

      res.writeHead(500, {
        "Content-Type": "text/plain",
      });

      res.end(err.message);

      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html",
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

          console.log("\n✅ ACCESS TOKEN:");
          console.log(ACCESS_TOKEN);

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

// Create HTTP server
const server = http.createServer((req, res) => {

  // CORS
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
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

  // Homepage
  if (
    req.url === "/" ||
    req.url === "/index.html"
  ) {

    serveIndex(res);
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

    const parsedUrl =
      url.parse(req.url, true);

    const requestToken =
      parsedUrl.query.request_token;

    if (!requestToken) {

      res.writeHead(400, {
        "Content-Type": "text/plain",
      });

      res.end("Missing request_token");

      return;
    }

    console.log("\n✅ REQUEST TOKEN:");
    console.log(requestToken);

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

        res.writeHead(200, {
          "Content-Type": "text/html",
        });

        res.end("<h2>Login Successful</h2>");
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
      status: "error",
      message: "Login first at /login",
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

  console.log(`➡️ ${req.method} ${req.url}`);

  const proxy =
    https.request(options, (kiteRes) => {

      let body = "";

      kiteRes.on("data", (chunk) => {
        body += chunk;
      });

      kiteRes.on("end", () => {

        console.log(`⬅️ ${kiteRes.statusCode}`);

        res.writeHead(
          kiteRes.statusCode,
          {
            "Content-Type":
              "application/json",

            "Access-Control-Allow-Origin":
              "*",
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