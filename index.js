import express from "express";
import session from "express-session";
import crypto from "crypto";
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Express session para guardar state y codeVerifier
app.use(session({
  secret: 'gargolas-secret',
  resave: false,
  saveUninitialized: true
}));

// Firebase Admin
if(!admin.apps.length){
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: "https://gargolascommunity.firebaseio.com"
  });
}

const CLIENT_ID = process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://tu-app.onrender.com/auth/kick/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tu-github.io/gargolas-community';

// =================== LOGIN KICK ===================
app.get('/auth/kick', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = crypto.randomBytes(43).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  req.session.state = state;
  req.session.codeVerifier = codeVerifier;

  const authUrl = `https://id.kick.com/oauth/authorize?` +
    `client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=user:read%20channel:read&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  res.redirect(authUrl);
});

app.get('/auth/kick/callback', async (req, res) => {
  const { code, state } = req.query;
  if(!req.session.state || req.session.state !== state){
    return res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }

  try{
    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code_verifier: req.session.codeVerifier
      })
    });

    const tokens = await tokenRes.json();
    if(!tokens.access_token) return res.redirect(`${FRONTEND_URL}?error=no_token`);

    const userRes = await fetch('https://kick.com/api/v1/user', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const kickUser = await userRes.json();

    // Crear Custom Token Firebase
    const firebaseToken = await admin.auth().createCustomToken(kickUser.id);

    // Guardar usuario en Firestore
    const userRef = admin.firestore().collection('gargolas').doc(kickUser.id);
    await userRef.set({
      nombre: kickUser.username || 'Gárgola',
      puntos: 0,
      watchtime_total: 0,
      recompensas: [],
      kick_user: kickUser.username
    }, { merge: true });

    res.redirect(`${FRONTEND_URL}?kick_token=${firebaseToken}&kick_user=${encodeURIComponent(JSON.stringify(kickUser))}`);

  } catch(err){
    console.error("Kick auth error:", err);
    res.redirect(`${FRONTEND_URL}?error=server_error`);
  }
});

// =================== WATCHTIME ===================
app.post('/api/watchtime', async (req, res) => {
  const { userId, minutes } = req.body;
  if(!userId || !minutes) return res.status(400).send({error:'Faltan datos'});

  const userRef = admin.firestore().collection('gargolas').doc(userId);
  const snap = await userRef.get();
  if(!snap.exists) return res.status(404).send({error:'Usuario no encontrado'});

  await userRef.update({
    puntos: (snap.data().puntos || 0) + minutes,
    watchtime_total: (snap.data().watchtime_total || 0) + minutes
  });

  res.send({ok:true});
});

// =================== RECOMPENSAS ===================
app.post('/api/recompra', async (req, res) => {
  const { userId, recompensaId } = req.body;
  if(!userId || !recompensaId) return res.status(400).send({error:'Faltan datos'});

  const userRef = admin.firestore().collection('gargolas').doc(userId);
  const rewardRef = admin.firestore().collection('recompensas').doc(recompensaId);

  const [userSnap, rewardSnap] = await Promise.all([userRef.get(), rewardRef.get()]);
  if(!userSnap.exists || !rewardSnap.exists) return res.status(404).send({error:'No encontrado'});

  const user = userSnap.data();
  const reward = rewardSnap.data();

  if(user.puntos >= reward.precio){
    await userRef.update({
      puntos: user.puntos - reward.precio,
      recompensas: admin.firestore.FieldValue.arrayUnion(recompensaId)
    });
    res.send({ok:true});
  } else res.status(400).send({error:'No tienes suficientes puntos'});
});

// =================== TOP WATCHTIME ===================
app.get('/api/topwatchtime', async (req, res) => {
  const snap = await admin.firestore().collection('gargolas')
    .orderBy('watchtime_total','desc').limit(10).get();
  res.send(snap.docs.map(d=>d.data()));
});

// =================== START SERVER ===================
app.listen(process.env.PORT || 3000, ()=> console.log('Server running'));
