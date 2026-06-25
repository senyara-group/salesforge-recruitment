const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile } = require('../utils/profiles');

router.get('/dashboard', authMiddleware, async (req, res) => {
  const candidat = await ensureCandidateProfile(req.user.id);
  const axes = candidat.axes?.resultat?.axes || [];
  res.json({
    streak: candidat.axes?.meta?.streak || 0,
    module_tag: 'Module du jour',
    module_title: 'SalesTech — CRM Avance',
    module_text: 'Module recommande depuis votre profil ADN.',
    cert_title: candidat.score_adn ? 'Certifie SalesForge' : 'Certification a debloquer',
    cert_sub: candidat.score_adn ? `Score ADN ${candidat.score_adn}/100` : 'Passez le test ADN',
    skills: (Array.isArray(axes) ? axes : []).map((axis) => ({
      l: axis.l,
      s: axis.v,
      fill: 'var(--bs)',
      ic: 'var(--b)',
      n: 1,
      weak: axis.v < 80,
    })),
  });
});

router.post('/start-module', authMiddleware, async (_req, res) => {
  res.json({ success: true });
});

module.exports = router;
