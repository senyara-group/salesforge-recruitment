const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/salesforge_landing.html'));
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
