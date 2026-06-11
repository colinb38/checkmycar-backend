// ============================================================
// mot-routes.js — Express routes for MOT History API
// ============================================================
// Mount in your main server file:
//
//   const motRoutes = require('./mot-routes');
//   app.use(motRoutes);
//
// Provides:
//   GET /api/mot/health          — credential & connectivity check
//   GET /api/mot/:registration   — full MOT history for a vehicle
// ============================================================

const express = require('express');
const router  = express.Router();
const { getMotHistory, testMotConnection } = require('../services/mot-service');

// ── GET /api/mot/health ────────────────────────────────────
router.get('/api/mot/health', async (req, res) => {
  try {
    const result  = await testMotConnection();
    const allGood = result.token && result.api;

    return res.status(allGood ? 200 : 503).json({
      status:  allGood ? 'healthy' : 'degraded',
      checks:  result,
    });
  } catch (err) {
    console.error('[MOT Route] Health check error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/mot/:registration ─────────────────────────────
router.get('/api/mot/:registration', async (req, res) => {
  const { registration } = req.params;

  if (!registration) {
    return res.status(400).json({ error: 'Registration parameter is required.' });
  }

  try {
    const motData = await getMotHistory(registration);
    return res.json(motData);
  } catch (err) {
    console.error(`[MOT Route] Error for "${registration}":`, err.message);

    const status = err.statusCode || 500;

    return res.status(status).json({
      error:        err.message,
      motErrorCode: err.motErrorCode || null,
    });
  }
});

module.exports = router;
