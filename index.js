import express from "express";
import nodeFetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const {
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  FRONTEND_URL,
  FIREBASE_SERVICE_ACCOUNT
} = process.env;

const REDIRECT_URI = "https://gargolas-backend.onrender.com/auth/kick/callback";
const KICK_CHANNEL = "maurooakd";
const POINTS_INTERVAL = 30 * 60 * 1000;
const POINTS_AMOUNT = 50;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
  });
}

const db = admin.firestore();
const viewersMap = new Map();

async function saveSession(state, verifier) {
  await db.collection('oauth_sessions').doc(state).set({
    verifier, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
  console.log("💾 Session:", state.substring(0, 8));
}

async function getSession(state) {
  const doc = await db.collection('oauth_sessions').doc(state).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (new Date() > data.expiresAt) {
    await db.collection('oauth_sessions').doc(state).delete();
    return null;
  }
  return data.verifier;
}

async function deleteSession(state) {
  await db.collection('oauth_sessions').doc(state).delete();
}

/* ============= LIVE DETECCIÓN - API OFICIAL KICK ============= */
async function isStreamLive() {
  console.log('🔍 Chequeando https://kick.com/maurooakd...');

  try {
    const response = await nodeFetch('https://kick.com/api/v2/channels/maurooakd', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://kick.com/maurooakd'
      }
    });
    
    if (!response.ok) {
      console.log(`❌ API ${response.status}`);
      return viewersMap.size >= 2;
    }
    
    const data = await response.json();
    const live = data.livestream?.is_live === true;
    
    console.log(`📺 https://kick.com/maurooakd → ${live ? '🔴 LIVE' : '⚫ OFFLINE'}`);
    console.log('👀 Viewers Kick oficial:', data.viewer_count || 0);
    
    return live;
  } catch (error) {
    console.error('❌ API maurookd fail:', error.message);
    return viewersMap.size >= 2;
  }
}

/* ============= VIEWER TRACKING - MAURO EXCLUIDO ============= */
app.post("/api/start-watching", async (req, res) => {
  console.log('📥 /start-watching:', req.body);
  
  const { username } = req.body;
  
  if (!username || typeof username !== 'string' || username.length < 2) {
    return res.status(400).json({ error: 'Username requerido', viewers: viewersMap.size });
  }

  if (username.toLowerCase() === 'maurooakd') {
    console.log('🚫 MAURO (streamer) excluido');
    return res.json({ success: true, viewers: viewersMap.size, excluded: true });
  }

  const oldSize = viewersMap.size;
  viewersMap.set(username, { startTime: Date.now(), lastActivity: Date.now() });
  console.log(`👀 ${username} (${oldSize}→${viewersMap.size}) SIN MAURO`);
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/stop-watching", (req, res) => {
  const { username } = req.body;
  if (username && viewersMap.has(username)) {
    const oldSize = viewersMap.size;
    viewersMap.delete(username);
    console.log(`👋 ${username} (${oldSize}→${viewersMap.size})`);
  }
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/user-activity", (req, res) => {
  const { username } = req.body;
  if (viewersMap.has(username)) {
    viewersMap.get(username).lastActivity = Date.now();
  }
  res.json({ success: true });
});

/* ============= WATCHTIME - SOLO CUANDO LIVE ============= */
async function saveWatchtime() {
  if (!await isStreamLive()) {
    console.log('⏱️ NO WATCHTIME: Mauro offline');
    return;
  }
  if (viewersMap.size === 0) return;

  try {
    const batch = db.batch();
    for (const [username, data] of viewersMap) {
      const secs = Math.floor((Date.now() - data.startTime) / 1000);
      batch.set(db.collection('watchtime').doc(username), {
        username,
        totalWatchtime: admin.firestore.FieldValue.increment(secs),
        lastUpdated: new Date()
      }, { merge: true });
    }
    await batch.commit();
    console.log(`💾 Watchtime: ${viewersMap.size} usuarios`);
  } catch (error) {
    console.error('❌ Watchtime error:', error.message);
  }
}

/* ============= PUNTOS - SOLO CUANDO LIVE ============= */
async function awardPoints() {
  if (!await isStreamLive()) {
    console.log('❌ NO PUNTOS: Mauro offline');
    return;
  }
  if (viewersMap.size === 0) return;

  try {
    const batch = db.batch();
    for (const [username] of viewersMap) {
      batch.set(db.collection('users').doc(username), {
        points: admin.firestore.FieldValue.increment(POINTS_AMOUNT),
        watching: true,
        lastPointsUpdate: new Date(),
        totalPointsEarned: admin.firestore.FieldValue.increment(POINTS_AMOUNT)
      }, { merge: true });
    }
    await batch.commit();
    console.log(`🎯 ${viewersMap.size} usuarios +${POINTS_AMOUNT} pts`);
  } catch (error) {
    console.error('❌ Points error:', error.message);
  }
}

/* ============= LIMPIEZA VIEWERS ============= */
async function cleanupInactiveViewers() {
  const now = Date.now();
  const inactive = [];
  for (const [username, data] of viewersMap) {
    if (now - data.lastActivity > 10 * 60 * 1000) {
      inactive.push(username);
    }
  }
  inactive.forEach(username => viewersMap.delete(username));
  if (inactive.length) {
    console.log(`🧹 Limpiado ${inactive.length} inactivos`);
  }
}

/* ============= API STATUS ============= */
app.get("/api/status", async (req, res) => {
  const live = await isStreamLive();
  console.log(`📊 Status: ${live ? '🔴 LIVE' : '⚫ OFFLINE'} | ${viewersMap.size} viewers SIN MAURO`);
  res.json({
    status: "running",
    viewers: viewersMap.size,
    live,
    channel: KICK_CHANNEL,
    timestamp: new Date().toISOString()
  });
});

/* ============= LEADERBOARDS ============= */
app.get("/api/top-watchtime", async (req, res) => {
  const snapshot = await db.collection("watchtime")
    .orderBy("totalWatchtime", "desc")
    .limit(10)
    .get();
  res.json(snapshot.docs.map((doc, i) => {
    const d = doc.data();
    return {
      position: i + 1,
      username: d.username,
      hours: Math.floor((d.totalWatchtime || 0) / 3600),
      minutes: Math.floor(((d.totalWatchtime || 0) % 3600) / 60),
      watching: viewersMap.has(d.username)
    };
  }));
});

app.get("/api/leaderboard", async (req, res) => {
  const snapshot = await db.collection("users")
    .orderBy("points", "desc")
    .limit(10)
    .get();
  res.json(snapshot.docs.map(doc => ({
    username: doc.id,
    points: doc.data().points || 0,
    watching: viewersMap.has(doc.id)
  })));
});

/* ============= OAUTH KICK ============= */
app.get("/auth/kick", async (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  await saveSession(state, verifier);
  
  const params = new URLSearchParams({
    client_id: KICK_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "user:read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  
  console.log('🔗 OAuth Kick iniciado');
  res.redirect(`https://id.kick.com/oauth/authorize?${params}`);
});

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    console.log('❌ OAuth error:', error || 'no code/state');
    return res.redirect(`${FRONTEND_URL}?error=auth`);
  }

  const verifier = await getSession(state);
  if (!verifier) {
    console.log('❌ OAuth state inválido');
    return res.redirect(`${FRONTEND_URL}?error=state`);
  }

  try {
    const tokenRes = await nodeFetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      })
    });
    
    const tokenData = await tokenRes.json();
    const userRes = await nodeFetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    });
    
    const userData = await userRes.json();
    const user = userData.data?.[0] || userData;
    const username = user.username || `kick_${user.id || Date.now()}`;
    
    console.log('✅ Usuario vinculado:', username);
    
    await db.collection('users').doc(username).set({
      kickId: user.id || 'unknown',
      username,
      avatar: user.profile_pic_url || '',
      points: 0,
      totalPointsEarned: 0,
      createdAt: new Date()
    }, { merge: true });

    const firebaseToken = await admin.auth().createCustomToken(
      `kick_${user.id || 'unknown'}`, 
      { username, provider: "kick" }
    );
    
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
  } catch (error) {
    console.error('❌ OAuth error:', error);
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?error=server`);
  }
});

/* ============= INTERVALS ============= */
setInterval(awardPoints, POINTS_INTERVAL);
setInterval(saveWatchtime, 5 * 60 * 1000);
setInterval(cleanupInactiveViewers, 2 * 60 * 1000);

app.listen(3000, () => {
  console.log("\n🚀 Gárgolas Backend LIVE ✅");
  console.log(`📺 https://kick.com/maurooakd - API OFICIAL`);
  console.log(`✅ Maurooakd EXCLUIDO de viewers`);
  console.log(`✅ Watchtime/Puntos SOLO cuando LIVE`);
  console.log(`✅ OAuth SIEMPRE funciona`);
});
