const axios = require('axios');

let accessToken = null;
let tokenExpiry = 0;

// ─── Get OAuth2 Access Token ─────────────────────────────
async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry) {
        return accessToken;
    }

    try {
        const response = await axios.put(
            'https://history.mot.api.gov.uk/v1/trade/credentials',
            {
                clientId: process.env.MOT_CLIENT_ID,
                clientSecret: process.env.MOT_CLIENT_SECRET,
            },
            {
                headers: { 'Content-Type': 'application/json' },
            }
        );

        accessToken = response.data.accessToken;
        // Token typically valid for ~1 hour; refresh 5 mins early
        tokenExpiry = Date.now() + (3600 * 1000) - (300 * 1000);
        return accessToken;

    } catch (error) {
        console.error('MOT API auth error:', error.response?.data || error.message);
        throw new Error('Failed to authenticate with MOT API');
    }
}

// ─── Fetch MOT History by Registration ───────────────────
async function getMotHistory(registration) {
    try {
        const token = await getAccessToken();
        const reg = registration.replace(/\s/g, '').toUpperCase();

        const response = await axios.get(
            `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${reg}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                },
                timeout: 10000,
            }
        );

        console.log(`   MOT data retrieved: ${response.data.motTests?.length || 0} tests found`);
        return response.data;

    } catch (error) {
        if (error.response?.status === 404) {
            console.log('   MOT: Vehicle not found (may be too new or Northern Ireland)');
            return null;
        }
        if (error.response?.status === 403) {
            console.error('   MOT: API key invalid or expired');
            return null;
        }
        console.error('   MOT API error:', error.message);
        return null;
    }
}

module.exports = { getMotHistory };
