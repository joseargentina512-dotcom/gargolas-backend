const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const CLIENT_ID = process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://tu-app.onrender.com/auth/kick/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tu-github.io/gargolas-community';

// 1. INICIAR LOGIN KICK
app.get('/auth/kick', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = crypto.randomBytes(43).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  
  // Session simple (mejora con Redis después)
  const sessionData = { state, codeVerifier, timestamp: Date.now() };
  req.session = sessionData; // Necesitas express-session
  
  const authUrl = `https://id.kick.com/oauth/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=user:read%20channel:read&` +
    `state=${state}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256`;
    
  res.redirect(authUrl);
});

// 2. CALLBACK KICK → FIREBASE TOKEN
app.get('/auth/kick/callback', async (req, res) => {
  const { code, state } = req.query;
  const session = req.session;
  
  if (!code || !session?.state || session.state !== state) {
    return res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
  
  try {
    // Intercambiar code por tokens Kick
    const tokenResponse = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code_verifier: session.codeVerifier
      })
    });
    
    const tokens = await tokenResponse.json();
    
    if (!tokens.access_token) {
      return res.redirect(`${FRONTEND_URL}?error=no_token`);
    }
    
    // Obtener datos usuario Kick
    const userResponse = await fetch('https://kick.com/api/v1/user', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    
    const kickUser = await userResponse.json();
    
    // AQUÍ: Firebase Admin SDK para crear Custom Token
    // (Instala firebase-admin en package.json)
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        databaseURL: "https://gargolascommunity.firebaseapp.com"
      });
    }
    
    // Crear Firebase Custom Token con Kick ID
    const firebaseToken = await admin.auth().createCustomToken(kickUser.id);
    
    // Redirigir al frontend CON token
    res.redirect(`${FRONTEND_URL}?kick_token=${firebaseToken}&kick_user=${encodeURIComponent(JSON.stringify(kickUser))}`);
    
  } catch (error) {
    console.error('Kick auth error:', error);
    res.redirect(`${FRONTEND_URL}?error=server_error`);
  }
});

app.listen(process.env.PORT || 3000);
