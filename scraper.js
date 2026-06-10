const { chromium } = require('playwright');
const cheerio = require('cheerio');

// ─── Site-Specific CSS Selectors ─────────────────────────
const SITE_CONFIGS = {
    'autotrader.co.uk': {
        title: 'h1.advert-heading__title, h1[data-testid="advert-title"]',
        price: '.advert-price__cash-price, [data-testid="advert-price"]',
        description: '.advert-description__text, [data-testid="advert-description"]',
        images: '.gallery__image img, [data-testid="gallery-image"] img, img[data-is-gallery]',
        specs: '.key-specifications li, [data-testid="key-specs"] li',
        seller: '.seller-info__name, [data-testid="seller-name"]',
    },
    'ebay.co.uk': {
        title: 'h1.x-item-title__mainTitle span, h1 span[role="heading"]',
        price: '.x-price-primary span, [data-testid="x-price-primary"]',
        description: '#desc_ifr, #viTabs_0_is',
        images: '.ux-image-carousel-item img, [data-testid="ux-image-carousel"] img',
        specs: '.ux-labels-values__labels-content, .section-title--keydetails ~ .vim',
        seller: '.x-sellercard-atf__info__about-seller span',
    },
    'gumtree.com': {
        title: 'h1[data-q="vip-title"]',
        price: 'h3[data-q="vip-price"], [data-q="ad-price"]',
        description: '[data-q="vip-description"], .vip-description',
        images: '[data-q="vip-gallery"] img, .vip-gallery img',
        specs: '.vip-attributes li',
        seller: '.seller-info__name, [data-q="seller-name"]',
    },
    'pistonheads.com': {
        title: '.listing-title, .advert-heading h1',
        price: '.price, .advert-price',
        description: '.listing-description, .advert-description',
        images: '.gallery-image img, .advert-image img',
        specs: '.spec-list li, .advert-specs li',
        seller: '.dealer-name, .seller-name',
    },
    'facebook.com': {
        title: '[data-testid="marketplace_listing_title"], h1 span',
        price: '[data-testid="marketplace_listing_price"], span[dir="auto"]',
        description: '[data-testid="marketplace_listing_description"]',
        images: 'img[data-testid="marketplace-listing-image"], img[src*="scontent"]',
        specs: '',
        seller: '[data-testid="marketplace_listing_seller"]',
    },
};

// ─── Detect Which Site ───────────────────────────────────
function detectSite(url) {
    for (const domain of Object.keys(SITE_CONFIGS)) {
        if (url.includes(domain)) return domain;
    }
    return null;
}

// ─── Main Scraping Function ──────────────────────────────
async function scrapeListingUrl(url) {
    const site = detectSite(url);
    const config = SITE_CONFIGS[site] || null;

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                       '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
        });

        const page = await context.newPage();

        // Block heavy resources for speed
        await page.route('**/*.{woff,woff2,ttf,otf}', route => route.abort());
        await page.route('**/*analytics*', route => route.abort());
        await page.route('**/*tracking*', route => route.abort());

        // Navigate
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Wait for JS rendering
        await page.waitForTimeout(3000);

        // Get full HTML
        const html = await page.content();
        const $ = cheerio.load(html);

        // ── Extract Data ──
        const result = {
            sourceUrl: url,
            sourceSite: site || 'unknown',
            title: extractText($, config?.title) || $('h1').first().text().trim(),
            price: extractText($, config?.price) || $('[class*="price"]').first().text().trim(),
            description: extractText($, config?.description) ||
                         $('[class*="description"]').first().text().trim(),
            images: [],
            specs: extractSpecs($, config?.specs),
            sellerType: extractText($, config?.seller) || '',
            scrapedAt: new Date().toISOString(),
        };

        // ── Extract Images ──
        // Try site-specific selectors first
        if (config?.images) {
            $(config.images).each((_, el) => {
                const src = $(el).attr('src') || $(el).attr('data-src') ||
                            $(el).attr('data-lazy-src');
                if (src && src.startsWith('http') && isListingImage(src)) {
                    result.images.push(src);
                }
            });
        }

        // Fallback: grab from page via Playwright evaluate
        if (result.images.length < 3) {
            const pageImages = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('img'))
                    .map(img => ({
                        src: img.src || img.dataset.src || '',
                        width: img.naturalWidth || img.width || 0,
                        height: img.naturalHeight || img.height || 0,
                    }))
                    .filter(img => img.src.startsWith('http'))
                    .filter(img => img.width > 200 || img.height > 200)
                    .filter(img => !img.src.includes('logo') && !img.src.includes('avatar'))
                    .map(img => img.src);
            });
            // Merge unique images
            const existing = new Set(result.images);
            for (const src of pageImages) {
                if (!existing.has(src)) result.images.push(src);
            }
        }

        // Limit to 10 images max
        result.images = [...new Set(result.images)].slice(0, 10);

        console.log(`   Scraped: "${result.title}" | ${result.images.length} images`);
        return result;

    } catch (error) {
        console.error('Scraper error:', error.message);
        return {
            sourceUrl: url, sourceSite: detectSite(url) || 'unknown',
            title: '', price: '', description: '',
            images: [], specs: {}, sellerType: '',
            error: error.message,
            scrapedAt: new Date().toISOString(),
        };
    } finally {
        if (browser) await browser.close();
    }
}

// ─── Helpers ─────────────────────────────────────────────
function extractText($, selector) {
    if (!selector) return '';
    return $(selector).first().text().trim();
}

function extractSpecs($, selector) {
    const specs = {};
    if (!selector) return specs;
    $(selector).each((_, el) => {
        const text = $(el).text().trim();
        const parts = text.split(/[:\-–]/);
        if (parts.length >= 2) {
            specs[parts[0].trim()] = parts.slice(1).join(':').trim();
        }
    });
    return specs;
}

function isListingImage(src) {
    const skip = ['logo', 'avatar', 'icon', 'badge', 'sprite', 'blank', 'pixel',
                  'tracking', '1x1', 'placeholder'];
    const lower = src.toLowerCase();
    return !skip.some(s => lower.includes(s));
}

module.exports = { scrapeListingUrl };
