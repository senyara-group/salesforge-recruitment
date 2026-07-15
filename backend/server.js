const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
 
const app = express();
app.disable('etag'); // désactive l'ETag auto d'Express (source des 304 sur /api/* avec données dynamiques)
app.use(cors());
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  } else if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend')));
 
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/salesforge_landing.html'));
});
 
// Config publique pour le frontend (clé anonyme Supabase : conçue pour être publique, protégée par RLS)
app.get('/api/config', (req, res) => {
  res.json({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
  });
});
 
// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/candidats', require('./routes/candidats'));
app.use('/api/recruteurs', require('./routes/recruteurs'));
app.use('/api/offres', require('./routes/offres'));
app.use('/api/matchs', require('./routes/matchs'));
app.use('/api/candidatures', require('./routes/candidatures'));
app.use('/api/swipes', require('./routes/swipes'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/abonnements', require('./routes/abonnements'));
app.use('/api/coaching', require('./routes/coaching'));
app.use('/api/community', require('./routes/community'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/ai', require('./routes/ai'));
 
const PORT = process.env.PORT || 3000;
 
if (require.main === module) {
  app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
}
 
module.exports = app;