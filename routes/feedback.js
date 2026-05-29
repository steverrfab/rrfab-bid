'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { sendFeedback } = require('../lib/email');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/', upload.single('attachment'), async (req, res) => {
  const { message, context } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  const file = req.file ? { buffer: req.file.buffer, name: req.file.originalname, type: req.file.mimetype } : null;
  const result = await sendFeedback(message.trim(), (context || '').trim(), file);
  res.json({ ok: true, email: result });
});

module.exports = router;
