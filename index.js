import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

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

/* ============= VIEWER TRACKING - MAURO EXCLUIDO ============= */
app.post("/api/start-watching", async (req, res) => {
  console.log('📥 POST /start-watching:', req.body);
  
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
  console.log(`👀 ${username} viendo (${oldSize}→${viewersMap.size}) SIN MAURO`);
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/stop-watching", (req, res) => {
  const { username } = req.body;
  if (username && viewersMap.has(username)) {
    const oldSize = viewersMap.size;
    viewersMap.delete(username);
    console.log(`👋 ${username} dejó (${oldSize}→${viewersMap.size})`);
  }
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/user-activity", (req, res) => {
  const { username } = req.body;
  if (viewersMap.has(username)) viewersMap.get(username).lastActivity = Date.now();
  res.json({ success: true });
});

/* ============= LIVE STATUS - 4 MÉTODOS ============= */
async function isStreamLive() {
  console.log('🔍 Chequeando si Mauro está LIVE...');

  // MÉTODO 1: API v1
  try {
    const res = await fetch(`https://kick.com/api/v1/channels/${KICK_CHANNEL}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.livestream?.is_live) {
        console.log('✅ LIVE API v1');
        return true;
      }
    }
  } catch {}

  // MÉTODO 2: API v2  
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.livestream?.is_live) {
        console.log('✅ LIVE API v2');
        return true;
      }
    }
  } catch {}

  // MÉTODO 3: Viewers threshold
  if (viewersMap.size >= 2) {
    console.log('✅ LIVE por viewers:', viewersMap.size);
    return true;
  }

  console.log('⚫ Mauro OFFLINE');
  return false;
}

/* ============= WATCHTIME + PUNTOS - SOLO LIVE ============= */
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
        username, totalWatchtime: admin.firestore.FieldValue.increment(secs),
        lastUpdated: new Date()
      }, { merge: true });
    }
    await batch.commit();
    console.log(`💾 Watchtime: ${viewersMap.size} usuarios`);
  } catch (error) {
    console.error('❌ Watchtime error:', error.message);
  }
}

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
        lastPointsUpdate: new Date()
      }, { merge: true });
    }
    await batch.commit();
    console.log(`🎯 ${viewersMap.size} usuarios +${POINTS_AMOUNT} pts`);
  } catch (error) {
    console.error('❌ Points error:', error.message);
  }
}

async function cleanupInactiveViewers() {
  const now = Date.now();
  const inactive = [];
  for (const [username, data] of viewersMap) {
    if (now - data.lastActivity > 10 * 60 * 1000) inactive.push(username);
  }
  inactive.forEach(username => viewersMap.delete(username));
  if (inactive.length) console.log(`🧹 Limpiado ${inactive.length} inactivos`);
}

/* ============= API ENDPOINTS ============= */
app.get("/api/status", async (req, res) => {
  const live = await isStreamLive();
  console.log(`📊 Status: ${live ? '🔴 LIVE' : '⚫ OFFLINE'} | Viewers: ${viewersMap.size}`);
  res.json({
    status: "running",
    viewers: viewersMap.size,
    live,
    channel: KICK_CHANNEL,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/top-watchtime", async (req, res) => {
  const snapshot = await db.collection("watchtime").orderBy("totalWatchtime", "desc").limit(10).get();
  res.json(snapshot.docs.map((doc, i) => {
    const d = doc.data();
    return {
      position: i + 1, username: d.username,
      hours: Math.floor((d.totalWatchtime || 0) / 3600),
      minutes: Math.floor(((d.totalWatchtime || 0) % 3600) / 60),
      watching: viewersMap.has(d.username)
    };
  }));
});

app.get("/api/leaderboard", async (req, res) => {
  const snapshot = await db.collection("users").orderBy("points", "desc").limit(10).get();
  res.json(snapshot.docs.map(doc => ({
    username: doc.id,
    points: doc.data().points || 0,
    watching: viewersMap.has(doc.id)
  })));
});

/* ============= OAUTH ============= */
app.get("/auth/kick", async (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  await saveSession(state, verifier);
  res.redirect(`https://id.kick.com/oauth/authorize?${new URLSearchParams({
    client_id: KICK_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: "code", scope: "user:read", state,
    code_challenge: challenge, code_challenge_method: "S256"
  })}`);
});

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.redirect(`${FRONTEND_URL}?error=auth`);

  const verifier = await getSession(state);
  if (!verifier) return res.redirect(`${FRONTEND_URL}?error=state`);

  try {
    const tokenData = await (await fetch("https://id.kick.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: KICK_CLIENT_ID, client_secret: KICK_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      })
    })).json();

    const userData = await (await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    })).json();

    const user = userData.data?.[0] || userData;
    const username = user.username || `kick_${user.id || Date.now()}`;
    
    await db.collection('users').doc(username).set({
      kickId: user.id, username, avatar: user.profile_pic_url || '',
      points: 0
    }, { merge: true });

    const firebaseToken = await admin.auth().createCustomToken(`kick_${user.id}`, { username });
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect(`${FRONTEND_URL}?error=server`);
  }
}

/* ============= INTERVALS ============= */
setInterval(awardPoints, POINTS_INTERVAL);
setInterval(saveWatchtime, 5 * 60 * 1000);
setInterval(cleanupInactiveViewers, 2 * 60 * 1000);

app.listen(3000, () => {
  console.log("\n🚀 Gárgolas Backend LIVE ✅");
  console.log(`📺 ${KICK_CHANNEL} - LIVE STATUS FIX`);
  console.log(`✅ Maurooakd EXCLUIDO + Watchtime/Puntos SOLO LIVE`);
});
