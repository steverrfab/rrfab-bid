'use strict';
const express = require('express');
const { signToken, verifyPassword } = require('../lib/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(password)) {
    return res.status(401).json({ error: 'wrong password' });
  }
  const token = signToken({ user: 'admin', t: Date.now() });
  res.json({ token });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

module.exports = router;
