const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { SYSTEM_PROMPT } = require('./prompt');

// ─── Initialise Gemini ───────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Fetch Image & Convert to Base64 ────────────────────
// Gemini requires images as inline base64 data (not URLs)
async function fetchImageAsBase64(imageUrl, timeoutMs = 10000) {
    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; CheckMyCar/1.0)',
                'Accept': 'image/*',
            },
        });

        const buffer = Buffer.from(response.data);
        const base64 = buffer.toString('base64');

        // Detect MIME type from Content-Type header or URL extension
        let mimeType = response.headers['content-type'] || 'image/jpeg';
        if (mimeType.includes(';')) mimeType = mimeType.split(';')[0].trim();
        if (!mimeType.startsWith('image/')) mimeType = 'image/jpeg';

        return { base64, mimeType };
    } catch (error) {
        console.warn(`   ⚠ Failed to fetch image: ${imageUrl.substring(0, 80)}...`);
        return null;
    }
}

// ─── Build Text Prompt from Scraped Data ─────────────────
function buildTextPrompt(listingData, motData) {
    let text = `Please analyse this used vehicle listing:\n\n`;
    text += `**Listing Title:** ${listingData.title || 'Not available'}\n`;
    text += `**Asking Price:** ${listingData.price || 'Not listed'}\n`;
    text += `**Source Site:** ${listingData.sourceSite}\n`;
    text += `**Seller:** ${listingData.sellerType || 'Unknown'}\n\n`;

    if (listingData.description) {
        text += `**Full Description:**\n${listingData.description}\n\n`;
    }

    // Include scraped specs
    if (Object.keys(listingData.specs).length > 0) {
        text += `**Listed Specifications:**\n`;
        for (const [key, value] of Object.entries(listingData.specs)) {
            text += `- ${key}: ${value}\n`;
        }
        text += '\n';
    }

    // Include MOT data if available
    if (motData) {
        text += `**MOT History (from DVLA — verified data):**\n`;
        if (motData.registration) text += `Registration: ${motData.registration}\n`;
        if (motData.make) text += `Make: ${motData.make}\n`;
        if (motData.model) text += `Model: ${motData.model}\n`;
        if (motData.firstUsedDate) text += `First Registered: ${motData.firstUsedDate}\n`;
        if (motData.fuelType) text += `Fuel Type: ${motData.fuelType}\n`;
        if (motData.primaryColour) text += `Colour: ${motData.primaryColour}\n\n`;

        if (motData.motTests && motData.motTests.length > 0) {
            text += `MOT Test Results:\n`;
            for (const test of motData.motTests.slice(0, 6)) {
                text += `- ${test.completedDate}: ${test.testResult}`;
                if (test.odometerValue) {
                    text += ` at ${test.odometerValue} ${test.odometerUnit || 'mi'}`;
                }
                text += '\n';

                if (test.defects && test.defects.length > 0) {
                    for (const defect of test.defects) {
                        text += `  → [${defect.type}] ${defect.text}\n`;
                    }
                }
            }
            text += '\nPlease include plain-English MOT analysis in your report.\n';
        }
    } else {
        text += `**MOT History:** Not available (no registration plate provided)\n`;
    }

    text += `\nI have attached ${listingData.images?.length || 0} photos from the listing.\n`;
    text += `Please analyse the photos for condition, modifications, damage, and anything `;
    text += `the buyer should know.\n`;
    text += `\nRespond with the full JSON report as specified in your instructions.`;

    return text;
}

// ═══════════════════════════════════════════════════════════
//  MAIN ANALYSIS FUNCTION
// ═══════════════════════════════════════════════════════════
async function analyseVehicle(listingData, motData = null) {
    console.log('   Preparing Gemini request...');

    // ── Step 1: Fetch and convert images to base64 ──
    // Gemini requires inline base64 images (not URLs like OpenAI)
    // Limit to 6 images to stay within free tier token budget
    const imageUrls = (listingData.images || []).slice(0, 6);
    const imageResults = await Promise.allSettled(
        imageUrls.map(url => fetchImageAsBase64(url))
    );

    const images = imageResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    console.log(`   Fetched ${images.length}/${imageUrls.length} images for analysis`);

    // ── Step 2: Build the content parts array ──
    const contents = [];

    contents.push({
        role: 'user',
        parts: [
            // Text part: the listing data + MOT
            { text: buildTextPrompt(listingData, motData) },

            // Image parts: base64-encoded listing photos
            ...images.map(img => ({
                inlineData: {
                    mimeType: img.mimeType,
                    data: img.base64,
                },
            })),
        ],
    });

    // ── Step 3: Call Gemini API ──
    console.log('   Calling Gemini 2.5 Flash...');
    const startTime = Date.now();

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',     // Free tier: 1,500 req/day
            contents: contents,
            config: {
                systemInstruction: SYSTEM_PROMPT,
                responseMimeType: 'application/json',  // Force JSON output
                temperature: 0.3,           // Lower = more consistent/factual
                maxOutputTokens: 8192,      // Plenty for the full report
            },
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // ── Step 4: Parse the response ──
        const rawText = response.text;
        let report;
        try {
            report = JSON.parse(rawText);
        } catch (parseError) {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = rawText.match(/```json?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                report = JSON.parse(jsonMatch[1]);
            } else {
                throw new Error('Gemini returned invalid JSON: ' + rawText.substring(0, 200));
            }
        }

        // ── Step 5: Log usage ──
        const usage = response.usageMetadata || {};
        console.log(`   ✅ Gemini response in ${elapsed}s`);
        console.log(`   📊 Tokens — Input: ${usage.promptTokenCount || '?'}, ` +
                    `Output: ${usage.candidatesTokenCount || '?'}, ` +
                    `Total: ${usage.totalTokenCount || '?'}`);
        console.log(`   💰 Cost: £0.00 (free tier)`);

        return report;

    } catch (error) {
        // ── Retry with text-only if image processing fails ──
        if (error.message?.includes('image') || error.status === 400) {
            console.warn('   ⚠ Image analysis failed, retrying text-only...');
            return await analyseTextOnly(listingData, motData);
        }

        // Rate limit hit
        if (error.status === 429) {
            throw new Error('Gemini free tier daily limit reached (1,500/day). Try again tomorrow.');
        }

        throw error;
    }
}

// ─── Fallback: Text-Only Analysis (no images) ───────────
async function analyseTextOnly(listingData, motData) {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
            role: 'user',
            parts: [{ text: buildTextPrompt(listingData, motData) }],
        }],
        config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 8192,
        },
    });

    return JSON.parse(response.text);
}

module.exports = { analyseVehicle };
