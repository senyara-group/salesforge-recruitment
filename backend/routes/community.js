const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

router.get('/stats', authMiddleware, (_req, res) => {
  res.json({
    count: 0,
    members: [],
    desc: 'Communaute synchronisee avec la base SalesForge.',
  });
});

module.exports = router;
