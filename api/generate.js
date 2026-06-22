const fs = require("fs");

const BASE = [
    { tradingsymbol: "LIQUIDCASE", exchange: "NSE", instrument_token: 5568001, isin: "INF0R8F01034", quantity: 48, average_price: 114.63 },
    { tradingsymbol: "TATAELXSI", exchange: "NSE", instrument_token: 873217, isin: "INE670A01012", quantity: 1, average_price: 4065.5 },
    { tradingsymbol: "BDL", exchange: "BSE", instrument_token: 138532612, isin: "INE171Z01026", quantity: 9, average_price: 1371.9 },
    { tradingsymbol: "AARTIIND", exchange: "BSE", instrument_token: 134197252, isin: "INE769A01020", quantity: 23, average_price: 484.7 },
    { tradingsymbol: "VAIBHAVGBL", exchange: "NSE", instrument_token: 2909185, isin: "INE884A01027", quantity: 9, average_price: 244.33 },
    { tradingsymbol: "GOLDBEES", exchange: "NSE", instrument_token: 3693569, isin: "INF204KB17I5", quantity: 6, average_price: 119.79 },
    { tradingsymbol: "DATAPATTNS", exchange: "BSE", instrument_token: 139117572, isin: "INE0IX101010", quantity: 1, average_price: 4812.35 },
    { tradingsymbol: "CROMPTON", exchange: "BSE", instrument_token: 138208260, isin: "INE299U01018", quantity: 1, average_price: 275.7 },
    { tradingsymbol: "BEL", exchange: "BSE", instrument_token: 128012548, isin: "INE263A01024", quantity: 11, average_price: 427.15 },
    { tradingsymbol: "BCG", exchange: "NSE", instrument_token: 2261249, isin: "INE425B01027", quantity: 26, average_price: 10.29 },
    { tradingsymbol: "PVRINOX", exchange: "BSE", instrument_token: 136368388, isin: "INE191H01014", quantity: 6, average_price: 949.25 },
    { tradingsymbol: "BANDHANBNK", exchange: "BSE", instrument_token: 138535172, isin: "INE545U01014", quantity: 29, average_price: 208.1 },
    { tradingsymbol: "SHAREINDIA", exchange: "NSE", instrument_token: 26625, isin: "INE932X01026", quantity: 33, average_price: 138.9 },
    { tradingsymbol: "ITBEES", exchange: "NSE", instrument_token: 4885505, isin: "INF204KB15V2", quantity: 161, average_price: 30.41 },
    { tradingsymbol: "AAVAS", exchange: "BSE", instrument_token: 138748932, isin: "INE216P01012", quantity: 7, average_price: 1461.2 },
    { tradingsymbol: "VBL", exchange: "NSE", instrument_token: 4843777, isin: "INE200M01039", quantity: 1, average_price: 529.5 },
    { tradingsymbol: "ZENTEC", exchange: "NSE", instrument_token: 1922049, isin: "INE251B01027", quantity: 1, average_price: 1997 },
    { tradingsymbol: "COFORGE", exchange: "BSE", instrument_token: 136330500, isin: "INE591G01025", quantity: 4, average_price: 1463.65 },
    { tradingsymbol: "TMPV", exchange: "BSE", instrument_token: 128145924, isin: "INE155A01022", quantity: 17, average_price: 359.5 },
    { tradingsymbol: "MODEFENCE", exchange: "NSE", instrument_token: 6385665, isin: "INF247L01DJ0", quantity: 29, average_price: 105.3 },
    { tradingsymbol: "ROSSARI", exchange: "NSE", instrument_token: 4968961, isin: "INE02A801020", quantity: 5, average_price: 560.9 },
    { tradingsymbol: "UTTAMSUGAR", exchange: "NSE", instrument_token: 3424257, isin: "INE786F01031", quantity: 3, average_price: 237.85 },
    { tradingsymbol: "TEJASNET", exchange: "NSE", instrument_token: 5409537, isin: "INE010J01012", quantity: 1, average_price: 632.35 },
    { tradingsymbol: "IEX", exchange: "BSE", instrument_token: 138432004, isin: "INE022Q01020", quantity: 33, average_price: 122.9 },
    { tradingsymbol: "HAPPSTMNDS", exchange: "NSE", instrument_token: 12289, isin: "INE419U01012", quantity: 11, average_price: 345.35 },
    { tradingsymbol: "JIOFIN", exchange: "BSE", instrument_token: 139248644, isin: "INE758E01017", quantity: 14, average_price: 244.6 },
    { tradingsymbol: "MAXHEALTH", exchange: "BSE", instrument_token: 139064324, isin: "INE027H01010", quantity: 2, average_price: 1092 },
    { tradingsymbol: "TCS", exchange: "BSE", instrument_token: 136330244, isin: "INE467B01029", quantity: 1, average_price: 2126.4 },
    { tradingsymbol: "WAAREEENER", exchange: "BSE", instrument_token: 139334916, isin: "INE377N01017", quantity: 3, average_price: 3127.4 },
    { tradingsymbol: "MOREALTY", exchange: "NSE", instrument_token: 5935105, isin: "INF247L01CI4", quantity: 25, average_price: 80.95 }
];

const LIQUID_SYMBOL = "LIQUIDCASE";
const TOTAL_VARIANTS = 10;

// Each stock gets ONE fixed day_change% cap (assigned once, reused across all
// variants). Most stocks: ±5%. A handful of "small/volatile" stocks: up to ±15%.
// This is the *today-only* move (day_change), independent of the cumulative
// net P&L (last_price vs average_price), which can land far outside ±15%.
const VOLATILE_SYMBOLS = new Set(["BCG", "MODEFENCE", "ITBEES", "TEJASNET", "ZENTEC"]);

function mulberry32(seed) {
    let s = seed;
    return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// ── Step 1: assign each stock a fixed day-change cap & "base" day% ─────────
// Drawn once (seeded), reused identically across all 10 variants so that
// per-stock volatility stays believable day-over-day (no -5% in one variant,
// +80% in the next).
const dayProfileRand = mulberry32(31337);
const liquidIdx = BASE.findIndex((s) => s.tradingsymbol === LIQUID_SYMBOL);

// Non-50/50 split for day-direction: randomize what fraction of stocks lean
// up vs down today (e.g. 35-65% up), same mechanism as the net-winner ratio.
const dayUpRatio = 0.35 + dayProfileRand() * 0.3; // 35-65%, rarely landing on 50%
const dayDirOrder = BASE.map((_, i) => i).sort(() => dayProfileRand() - 0.5);
const dayUpCount = Math.round(BASE.length * dayUpRatio);
const isDayUp = new Array(BASE.length).fill(false);
dayDirOrder.slice(0, dayUpCount).forEach((i) => (isDayUp[i] = true));

const dayProfiles = BASE.map((s, i) => {
    if (i === liquidIdx) {
        return { capPct: 0.1, basePct: 0.02, sign: 1 };
    }
    const isVolatile = VOLATILE_SYMBOLS.has(s.tradingsymbol);
    const capPct = isVolatile ? 15 + dayProfileRand() * 5 : 5 + dayProfileRand() * 5; // volatile: 15-20%, normal: 5-10%
    const sign = isDayUp[i] ? 1 : -1; // direction driven by the randomized, non-50/50 ratio above
    const basePct = sign * capPct * (0.4 + dayProfileRand() * 0.4); // sits at 40-80% of its own cap, same direction
    return { capPct, basePct, sign };
});

// ── Feasibility check: what's the max achievable day P&L given the fixed
// per-stock caps and investment sizes? If the 1.8-2.5% target needs more
// headroom than exists, no amount of redistribution will reach it. ──
{
    const investmentsCheck = BASE.map((s) => s.quantity * s.average_price);
    const totalInvestmentCheck = investmentsCheck.reduce((a, b) => a + b, 0);
    const maxPositiveDayPnl = BASE.reduce((acc, s, i) => {
        if (i === liquidIdx) return acc;
        return acc + investmentsCheck[i] * (dayProfiles[i].capPct / 100);
    }, 0);
    const maxPositiveDayPct = (maxPositiveDayPnl / totalInvestmentCheck) * 100;
    console.log(`Feasibility: total investment ₹${totalInvestmentCheck.toFixed(2)}, max possible day P&L if ALL stocks at +cap = ${maxPositiveDayPct.toFixed(2)}% (target band: 1.8-2.5%)`);
    if (maxPositiveDayPct < 2.5) {
        console.log("⚠ NOTE: max achievable is below the top of the target band — variants will cluster near the ceiling rather than spanning 1.8-2.5%.");
    }
}

// ── Step 2: net winner/loser bucketing, fixed once, non-50/50 split ────────
const netProfileRand = mulberry32(90210);
const netWinRatio = 0.55 + netProfileRand() * 0.2; // 55-75% of stocks are net winners
const netOrder = BASE.map((_, i) => i).sort(() => netProfileRand() - 0.5);
const netWinCount = Math.round(BASE.length * netWinRatio);
const isNetWinner = new Array(BASE.length).fill(false);
netOrder.slice(0, netWinCount).forEach((i) => (isNetWinner[i] = true));

function generateVariant(seed) {
    const rand = mulberry32(seed);
    const investments = BASE.map((s) => s.quantity * s.average_price);
    const totalInvestment = investments.reduce((a, b) => a + b, 0);

    // ── Net P&L: each stock independently randomized within -30% to +40%,
    // no fixed combined target, but skewed (via isNetWinner, non-50/50) so
    // the combined total is usually positive across variants. ──
    const lastPrice = BASE.map((s, i) => {
        if (i === liquidIdx) {
            const pnl = round2(investments[i] * (0.02 + rand() * 0.05) / 100);
            return round2(s.average_price + pnl / s.quantity);
        }
        const isWinner = isNetWinner[i];
        // Winners: 0% to +40%. Losers: -30% to 0%. Keeps the hard -30/+40 range
        // while the winner/loser split itself stays non-50/50 (fixed per stock).
        const pct = isWinner ? rand() * 40 : -(rand() * 30);
        return round2(s.average_price * (1 + pct / 100));
    });

    // ── Day's P&L: each stock's day_change_percentage random within its
    // fixed per-stock cap (unchanged), combined total loosely targeted to
    // -2% to +3% but allowed to swing variant to variant. ──
    const targetDayPct = -2 + rand() * 5; // -2% to +3%
    const targetDayPnl = totalInvestment * (targetDayPct / 100);

    let dayChangePctOfClose = BASE.map((s, i) => {
        if (i === liquidIdx) {
            return dayProfiles[i].basePct + (rand() - 0.5) * 0.04;
        }
        const { capPct, basePct } = dayProfiles[i];
        const wiggle = capPct * 0.15;
        let pct = basePct + (rand() - 0.5) * 2 * wiggle;
        return Math.max(-capPct, Math.min(capPct, pct));
    });

    const computeDayChangeFromPct = (i, pct) => {
        const lp = lastPrice[i];
        return (lp * (pct / 100)) / (1 + pct / 100);
    };

    const aggregateDayPnl = (pctArr) =>
        BASE.reduce((acc, s, i) => acc + computeDayChangeFromPct(i, pctArr[i]) * s.quantity, 0);

    let currentDayPnl = aggregateDayPnl(dayChangePctOfClose);

    for (let pass = 0; pass < 10; pass++) {
        const gap = targetDayPnl - currentDayPnl;
        if (Math.abs(gap) < 0.5) break;

        const gapSign = Math.sign(gap);
        const headroom = BASE.map((s, i) => {
            if (i === liquidIdx) return 0;
            const cap = dayProfiles[i].capPct;
            const room = gapSign > 0 ? (cap - dayChangePctOfClose[i]) : (dayChangePctOfClose[i] - (-cap));
            return Math.max(0, room) * investments[i];
        });
        const headroomSum = headroom.reduce((a, b) => a + b, 0);
        if (headroomSum < 1) break;

        BASE.forEach((s, i) => {
            if (i === liquidIdx || headroom[i] <= 0) return;
            const share = headroom[i] / headroomSum;
            const addPnl = gap * share;
            const lp = lastPrice[i];
            const approxAddPct = (addPnl / s.quantity / lp) * 100;
            let newPct = dayChangePctOfClose[i] + approxAddPct;
            const cap = dayProfiles[i].capPct;
            newPct = Math.max(-cap, Math.min(cap, newPct));
            dayChangePctOfClose[i] = newPct;
        });

        currentDayPnl = aggregateDayPnl(dayChangePctOfClose);
    }

    return BASE.map((s, i) => {
        const last_price = lastPrice[i];
        const day_change_percentage = round2(dayChangePctOfClose[i]);
        const day_change = round2(computeDayChangeFromPct(i, day_change_percentage));
        const close_price = round2(last_price - day_change);
        const finalPnl = round2((last_price - s.average_price) * s.quantity);

        return {
            tradingsymbol: s.tradingsymbol,
            exchange: s.exchange,
            instrument_token: s.instrument_token,
            isin: s.isin,
            product: "CNC",
            price: 0,
            quantity: s.quantity,
            used_quantity: 0,
            t1_quantity: 0,
            realised_quantity: s.quantity,
            authorised_quantity: 0,
            authorised_date: "2026-06-21 00:00:00",
            authorisation: {},
            opening_quantity: s.quantity,
            short_quantity: 0,
            collateral_quantity: 0,
            collateral_type: "",
            discrepancy: false,
            average_price: s.average_price,
            last_price,
            close_price,
            pnl: finalPnl,
            day_change,
            day_change_percentage,
            mtf: { quantity: 0, used_quantity: 0, average_price: 0, value: 0, initial_margin: 0 },
        };
    });
}

const variants = [];
for (let v = 0; v < TOTAL_VARIANTS; v++) {
    variants.push(generateVariant(7000 + v * 137));
}

let allOk = true;
let positiveNetCount = 0;
variants.forEach((variant, idx) => {
    const inv = variant.reduce((a, s) => a + s.quantity * s.average_price, 0);
    const netPnl = variant.reduce((a, s) => a + s.pnl, 0);
    const dayPnl = variant.reduce((a, s) => a + s.day_change * s.quantity, 0);
    const netPct = (netPnl / inv) * 100;
    const dayPct = (dayPnl / inv) * 100;
    if (netPct > 0) positiveNetCount++;

    const netRangeBreaches = variant.filter((s) => {
        if (s.tradingsymbol === LIQUID_SYMBOL) return false;
        const stockNetPct = ((s.last_price - s.average_price) / s.average_price) * 100;
        return stockNetPct < -30.5 || stockNetPct > 40.5;
    });

    const dayCapBreaches = variant.filter((s, i) => {
        if (s.tradingsymbol === LIQUID_SYMBOL) return false;
        return Math.abs(s.day_change_percentage) > dayProfiles[i].capPct + 0.05;
    });

    const dayOk = dayPct >= -2.1 && dayPct <= 3.1;

    if (netRangeBreaches.length || dayCapBreaches.length || !dayOk) allOk = false;
    console.log(
        `Variant ${idx}: inv=₹${inv.toFixed(2)}  netPnl=₹${netPnl.toFixed(2)} (${netPct.toFixed(2)}%)  dayPnl=₹${dayPnl.toFixed(2)} (${dayPct.toFixed(2)}%)${dayOk ? "" : " ⚠ DAY OUT OF RANGE"}${netRangeBreaches.length ? `  ⚠ NET RANGE BREACH: ${netRangeBreaches.map(s => s.tradingsymbol).join(", ")}` : ""}${dayCapBreaches.length ? `  ⚠ DAY CAP BREACH: ${dayCapBreaches.map(s => s.tradingsymbol).join(", ")}` : ""}`
    );
});

console.log(`\nCombined net P&L positive in ${positiveNetCount}/${TOTAL_VARIANTS} variants (expected: most, due to non-50/50 winner skew).`);

if (!allOk) {
    console.log("⚠️  Some variants are out of range. Adjust seeds or magnitude ranges and re-run.");
} else {
    console.log("✅ All 10 variants: each stock's net P&L within -30%/+40%, day P&L within per-stock caps, combined day P&L within -2%/+3%.");
}

fs.writeFileSync("./api/mock-holdings.json", JSON.stringify({ variants }, null, 2));
console.log("Done!");