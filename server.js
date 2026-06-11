require('dotenv').config();
const motRoutes = require('./routes/mot-routes');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { scrapeListingUrl } = require('./services/scraper');
const { analyseVehicle } = require('./services/gemini-analyser');
const { getMotHistory } = require('./services/mot-service');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────
app.use(helmet());
app.use(cors({
    origin: ['https://checkmycarpurchase.info', 'https://www.checkmycarpurchase.info', 'http://localhost:5500', 'http://127.0.0.1:5500'],
}));
app.use(express.json());
app.use(motRoutes);

// ─── Rate Limiter: 10 reports per hour per IP ────────────
const rateLimiter = new RateLimiterMemory({
    points: 10,
    duration: 3600, // 1 hour
});

// ─── Health Check ────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        aiProvider: 'Google Gemini 2.5 Flash (free tier)',
        version: '1.0.0',
    });
});

// ─── MAIN ANALYSIS ENDPOINT ─────────────────────────────
app.post('/api/analyse', async (req, res) => {
    const startTime = Date.now();

    try {
        // Rate limiting
        const clientIp = req.headers['x-forwarded-for'] || req.ip;
        await rateLimiter.consume(clientIp);

        const { url, regPlate } = req.body;

        // Validate URL
        if (!url || !isValidUrl(url)) {
            return res.status(400).json({
                error: 'Please provide a valid listing URL.',
            });
        }

        // ── Step 1: Scrape the listing ──
        console.log('[1/3] Scraping listing:', url);
        const listingData = await scrapeListingUrl(url);

        if (!listingData.title && !listingData.description) {
            return res.status(422).json({
                error: 'Could not extract data from this listing. The page may be ' +
                       'behind a login wall or the site may not be supported yet.',
            });
        }

        // ── Step 2: Fetch MOT history (if reg plate provided) ──
        let motData = null;
        if (regPlate && isValidRegPlate(regPlate)) {
            console.log('[2/3] Fetching MOT history for:', regPlate);
            motData = await getMotHistory(regPlate);
        } else {
            console.log('[2/3] No valid reg plate — skipping MOT lookup');
        }

        // ── Step 3: Run Gemini AI analysis ──
        console.log('[3/3] Running Gemini AI analysis...');
        const report = await analyseVehicle(listingData, motData);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Report generated in ${elapsed}s`);

        // Return complete report
        return res.json({
            success: true,
            report,
            meta: {
                listingUrl: url,
                regPlate: regPlate || null,
                aiModel: 'gemini-2.5-flash',
                cost: '£0.00 (free tier)',
                generatedAt: new Date().toISOString(),
                elapsedSeconds: parseFloat(elapsed),
            },
        });

    } catch (error) {
        // Rate limit exceeded
        if (error.constructor?.name === 'RateLimiterRes') {
            return res.status(429).json({
                error: 'Rate limit exceeded. Maximum 10 reports per hour.',
            });
        }

        console.error('❌ Analysis error:', error.message || error);
        return res.status(500).json({
            error: 'Analysis failed. Please try again in a moment.',
        });
    }
});

// ─── Validation Helpers ──────────────────────────────────
function isValidUrl(str) {
    try {
        const u = new URL(str);
        return ['http:', 'https:'].includes(u.protocol);
    } catch {
        return false;
    }
}

function isValidRegPlate(plate) {
    const clean = plate.replace(/\s/g, '').toUpperCase();
    // UK format: AB12CDE or A123BCD etc.
    return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(clean) ||
           /^[A-Z]\d{1,3}[A-Z]{3}$/.test(clean) ||
           /^[A-Z]{3}\d{1,3}[A-Z]$/.test(clean);
}

// ─── Start Server ────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚗 CheckMyCar backend running on http://localhost:${PORT}`);
    console.log(`   AI Engine: Google Gemini 2.5 Flash-Lite (Tier 1)`);
    console.log(`   Fallback to Gemini 2.5 Flash\n`);
});
