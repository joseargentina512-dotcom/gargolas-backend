const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public')); // Para tu frontend

const CLIENT_ID = process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://tu-app.onrender.com/auth/kick/callback';

// Ruta para iniciar login Kick
app.get('/auth/kick', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  
  // Guardar state y verifier en memoria (usa Redis en prod)
  req.session = { state, codeVerifier }; // Necesitas express-session
  
  const scopes = 'user:read channel:read';
  const authUrl = `https://id.kick.com/oauth/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${state}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256`;
  
  res.redirect(authUrl);
});

// Callback: intercambia code por tokens
app.get('/auth/kick/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code || req.session.state !== state) {
    return res.status(400).send('Error de autenticación');
  }
  
  try {
    const tokenResponse = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code_verifier: req.session.codeVerifier
      })
    });
    
    const tokens = await tokenResponse.json();
    
    if (tokens.access_token) {
      // Obtener datos usuario
      const userResponse = await fetch('https://api.kick.com/public/v1/users', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const userData = await userResponse.json();
      
      // Aquí integra con Firebase: crea/guarda usuario
      // firebase.auth().createUserWithEmailAndPassword(...)
      
      // Redirige al frontend con token o datos
      res.json({ 
        success: true, 
        user: userData.data[0], 
        token: tokens.access_token 
      });
    } else {
      res.status(400).send('Error obteniendo tokens');
    }
  } catch (error) {
    console.error(error);
    res.status(500).send('Error servidor');
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server corriendo en Render');
});
