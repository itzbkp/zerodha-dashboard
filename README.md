# Zerodha Dashboard (0dash)

Zerodha Dashboard is a portfolio tracking tool that helps you monitor your holdings, organize them into custom tags or groups, and track their performance.

🌐 **Visit Here -** [0dash.vercel.app](https://0dash.vercel.app)

## Tech Stack

- **Backend:** Node.js (`server.js`), proxying the Kite Connect API
- **Frontend:** Single-page `index.html`
- **Database:** Neon (serverless Postgres)
- **Email:** Resend + `quill-delta-to-html`
- **Image hosting:** ImgBB
- **Market data:** Yahoo Finance (for mock holdings)
- **Web Hosting:** Vercel
- **DNS Hosting:** Cloudflare
- **Domain:** DigitalPlat

## Getting Started

1. Clone the repo

   ```bash
   git clone https://github.com/itzbkp/zerodha-dashboard.git
   cd zerodha-dashboard
   ```

2. Install dependencies

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in your credentials:
   - Kite Connect API key/secret
   - Neon `DATABASE_URL`
   - Resend API key
   - ImgBB API key

4. Run the server
   ```bash
   node server.js
   ```

## Auth

Authentication is fully delegated to Zerodha's Kite Connect OAuth flow. On login, a `kite_session` httpOnly cookie is issued per user — no login credentials are stored server-side.
