'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();

// GET /api/template/takeoff -> downloads the Excel takeoff template
router.get('/takeoff', (req, res) => {
  const file = path.join(__dirname, '..', 'templates', 'RR_Bid_Takeoff_Template.xlsx');
  res.download(file, 'RR_Bid_Takeoff_Template.xlsx', (err) => {
    if (err) {
      console.error('template download error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'download failed' });
    }
  });
});

module.exports = router;
