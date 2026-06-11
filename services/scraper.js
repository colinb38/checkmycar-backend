// ============================================================
// scraper.js — Playwright + Cheerio Vehicle Listing Scraper
// ============================================================
// Supports: AutoTrader, eBay, Gumtree, PistonHeads, Facebook
// eBay-specific: realistic headers, cookie consent, lazy-image
//                extraction, thumbnail → full-size URL upgrade,
//                and random delay to avoid bot detection.
// ============================================================

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

// ─── eBay: Upgrade Thumbnail URL → Full-Size ─────────────
function upgradeEbayImageUrl(url) {
    // eBay thumbnails use s-l140.jpg, s-l225.jpg, s-l300.jpg, etc.
    // Replace with s-l1600 for full-size images
    return url.replace(/s-l\d+\./, 's-l1600.');
}

// ─── eBay: Extract Specs from Label/Value Pairs ──────────
function extractEbaySpecs($) {
    const specs = {};

    // Method 1: .ux-labels-values containers
    $('.ux-labels-values').each((_, container) => {
        const label = $(container).find('.ux-labels-values__labels-content, .ux-labels-values__labels').first().text().trim();
        const value = $(container).find('.ux-labels-values__values-content, .ux-labels-values__values').first().text().trim();
        if (label && value) {
            specs[label] = value;
        }
    });

    // Method 2: Item specifics section
    $('.ux-layout-section-evo__col').each((_, col) => {
        const labels = $(col).find('.ux-labels-values__labels');
        const values = $(col).find('.ux-labels-values__values');
        labels.each((i, labelEl) => {
            const label = $(labelEl).text().trim();
            const value = $(values.get(i)).text().trim();
            if (label && value) {
                specs[label] = value;
            }
        });
    });

    return specs;
}

// ─── Random Delay Helper ─────────────────────────────────
function randomDelay(minMs, maxMs) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main Scraping Function ──────────────────────────────
async function scrapeListingUrl(url) {
    const site = detectSite(url);
    const config = SITE_CONFIGS[site] || null;
    const isEbay = site === 'ebay.co.uk';
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        // ── Browser context — realistic headers for eBay ──
        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                       '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'en-GB',
            timezoneId: 'Europe/London',
        };

        // eBay needs extra headers to avoid bot detection
        if (isEbay) {
            contextOptions.extraHTTPHeaders = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Sec-Ch-Ua': '"Chromium";v="131", "Google Chrome";v="131"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            };
        }

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        // ── Hide automation signals ──
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        // ── Block heavy / tracking resources for speed ──
        await page.route('**/*.{woff,woff2,ttf,otf}', route => route.abort());
        await page.route('**/*analytics*', route => route.abort());
        await page.route('**/*tracking*', route => route.abort());
        await page.route('**/*doubleclick*', route => route.abort());
        await page.route('**/*googlesyndication*', route => route.abort());
        await page.route('**/*facebook.com/tr*', route => route.abort());
        await page.route('**/*hotjar*', route => route.abort());
        await page.route('**/*adservice*', route => route.abort());

        // ── Navigate ──
        console.log(`   Navigating to: ${url.substring(0, 80)}...`);
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // ── eBay-specific: handle cookie consent + delay ──
        if (isEbay) {
            // Dismiss cookie banner if present
            try {
                const cookieBtn = page.locator('#gdpr-banner-accept, [data-testid="gdpr-banner-accept"], #consent-page-accept');
                await cookieBtn.click({ timeout: 3000 }).catch(() => {});
            } catch (_) { /* No cookie banner — that's fine */ }

            // Random delay to appear human-like
            console.log('   eBay detected — adding realistic delay...');
            await randomDelay(2000, 4000);

            // Scroll down to trigger lazy-loading of images
            await page.evaluate(() => window.scrollBy(0, 800));
            await randomDelay(1000, 2000);
            await page.evaluate(() => window.scrollBy(0, 600));
            await randomDelay(500, 1000);
        }

        // Wait for JS rendering
        await page.waitForTimeout(3000);

        // ── Get full HTML ──
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

        // ── eBay: Enhanced spec extraction ──
        if (isEbay && Object.keys(result.specs).length === 0) {
            result.specs = extractEbaySpecs($);
        }

        // ── eBay: Try to extract description from iframe ──
        if (isEbay && !result.description) {
            try {
                const iframeEl = page.frameLocator('#desc_ifr');
                const iframeText = await iframeEl
                    .locator('body')
                    .innerText({ timeout: 5000 })
                    .catch(() => '');
                if (iframeText) result.description = iframeText.trim();
            } catch (_) { /* iframe not available */ }
        }

        // ── Extract Images ──
        // Try site-specific selectors first
        if (config?.images) {
            $(config.images).each((_, el) => {
                const src = $(el).attr('src') ||
                            $(el).attr('data-src') ||
                            $(el).attr('data-lazy-src') ||
                            $(el).attr('data-zoom-src');     // eBay uses this

                if (src && src.startsWith('http') && isListingImage(src)) {
                    result.images.push(isEbay ? upgradeEbayImageUrl(src) : src);
                }
            });
        }

        // ── eBay: Also extract from data-zoom-src on all imgs ──
        if (isEbay && result.images.length < 3) {
            $('img[data-zoom-src]').each((_, el) => {
                const zoomSrc = $(el).attr('data-zoom-src');
                if (zoomSrc && zoomSrc.startsWith('http') && isListingImage(zoomSrc)) {
                    result.images.push(upgradeEbayImageUrl(zoomSrc));
                }
            });
        }

        // ── eBay: Try to extract image URLs from embedded JSON ──
        if (isEbay && result.images.length < 3) {
            try {
                const ebayImages = await page.evaluate(() => {
                    const imgs = [];

                    // Method 1: Look in image carousel data attributes
                    document.querySelectorAll('[data-idx] img, .ux-image-carousel-item img').forEach(img => {
                        const src = img.getAttribute('data-zoom-src') ||
                                    img.getAttribute('data-src') ||
                                    img.src;
                        if (src && src.startsWith('http')) imgs.push(src);
                    });

                    // Method 2: Parse from script tags containing image arrays
                    document.querySelectorAll('script').forEach(script => {
                        const text = script.textContent || '';
                        const matches = text.match(/https:\/\/i\.ebayimg\.com\/images\/g\/[^"'\s]+/g);
                        if (matches) imgs.push(...matches);
                    });

                    return [...new Set(imgs)];
                });

                const existing = new Set(result.images);
                for (const src of ebayImages) {
                    if (!existing.has(src) && isListingImage(src)) {
                        result.images.push(upgradeEbayImageUrl(src));
                        existing.add(src);
                    }
                }
            } catch (e) {
                console.warn('   ⚠ eBay embedded image extraction failed:', e.message);
            }
        }

        // ── Fallback: grab from page via Playwright evaluate ──
        if (result.images.length < 3) {
            const pageImages = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('img'))
                    .map(img => ({
                        src: img.getAttribute('data-zoom-src') ||
                             img.getAttribute('data-src') ||
                             img.src || '',
                        width: img.naturalWidth || img.width || 0,
                        height: img.naturalHeight || img.height || 0,
                    }))
                    .filter(img => img.src.startsWith('http'))
                    .filter(img => img.width > 200 || img.height > 200)
                    .filter(img =>
                        !img.src.includes('logo') &&
                        !img.src.includes('avatar') &&
                        !img.src.includes('icon')
                    )
                    .map(img => img.src);
            });

            // Merge unique images
            const existing = new Set(result.images);
            for (const src of pageImages) {
                if (!existing.has(src)) {
                    result.images.push(isEbay ? upgradeEbayImageUrl(src) : src);
                    existing.add(src);
                }
            }
        }

        // Deduplicate and limit to 10 images max
        result.images = [...new Set(result.images)].slice(0, 10);

        // ── Log results (never throw on 0 images) ──
        if (result.images.length === 0) {
            console.warn(`   ⚠ No images scraped from ${site || 'unknown'} — continuing with text-only analysis`);
        } else {
            console.log(`   Scraped: "${result.title}" | ${result.images.length} images`);
        }

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
                  'tracking', '1x1', 'placeholder', 'spacer', 'shim'];
    const lower = src.toLowerCase();
    return !skip.some(s => lower.includes(s));
}

module.exports = { scrapeListingUrl };
