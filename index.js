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

/* ============= FIRESTORE SESSIONS ============= */
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
    console.error('❌ ERROR: username inválido:', username);
    return res.status(400).json({ error: 'Username requerido', viewers: viewersMap.size });
  }

  // ✅ MAUROOAKD NO CUENTA COMO VIEWER (STREAMER)
  if (username.toLowerCase() === 'maurooakd') {
    console.log('🚫 MAURO (streamer) excluido de viewers');
    return res.json({ success: true, viewers: viewersMap.size, excluded: true });
  }

  const oldSize = viewersMap.size;
  viewersMap.set(username, { 
    startTime: Date.now(), 
    lastActivity: Date.now() 
  });
  
  console.log(`👀 ${username} viendo (${oldSize}→${viewersMap.size}) TOTAL (SIN MAURO)`);
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/stop-watching", (req, res) => {
  console.log('📥 POST /stop-watching:', req.body);
  
  const { username } = req.body;
  if (username && viewersMap.has(username)) {
    const oldSize = viewersMap.size;
    viewersMap.delete(username);
    console.log(`👋 ${username} dejó de ver (${oldSize}→${viewersMap.size}) (SIN MAURO)`);
  }
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/user-activity", (req, res) => {
  const { username } = req.body;
  if (viewersMap.has(username)) {
    viewersMap.get(username).lastActivity = Date.now();
    console.log(`✅ ${username} activo (SIN MAURO)`);
  }
  res.json({ success: true });
});

/* ============= WATCHTIME - SOLO CUANDO MAURO LIVE ============= */
async function saveWatchtime() {
  const isLive = await isStreamLive();
  if (!isLive) {
    console.log('⏱️ NO WATCHTIME: Mauro offline');
    return;
  }
  
  if (viewersMap.size === 0) {
    console.log('⏱️ No hay viewers, skip watchtime');
    return;
  }

  try {
    const batch = db.batch();
    let operations = 0;

    for (const [username, data] of viewersMap.entries()) {
      const secs = Math.floor((Date.now() - data.startTime) / 1000);
      batch.set(db.collection('watchtime').doc(username), {
        username,
        totalWatchtime: admin.firestore.FieldValue.increment(secs),
        watchTimeSeconds: admin.firestore.FieldValue.increment(secs),
        lastUpdated: new Date()
      }, { merge: true });
      operations++;
    }

    if (operations > 0) {
      await batch.commit();
      console.log(`💾 Watchtime OK: ${operations} usuarios (MAURO LIVE + SIN MAURO)`);
    }
  } catch (error) {
    console.error('❌ Error saveWatchtime:', error.message);
  }
}

/* ============= PUNTOS - SOLO CUANDO MAURO LIVE ============= */
async function awardPoints() {
  const isLive = await isStreamLive();
  if (!isLive) {
    console.log('❌ NO PUNTOS: Mauro offline');
    return;
  }
  
  if (viewersMap.size === 0) {
    console.log('❌ NO PUNTOS: No hay viewers');
    return;
  }

  try {
    const batch = db.batch();
    let operations = 0;

    for (const [username] of viewersMap) {
      batch.set(db.collection('users').doc(username), {
        points: admin.firestore.FieldValue.increment(POINTS_AMOUNT),
        watching: true, 
        lastPointsUpdate: new Date(),
        totalPointsEarned: admin.firestore.FieldValue.increment(POINTS_AMOUNT)
      }, { merge: true });
      operations++;
    }

    if (operations > 0) {
      await batch.commit();
      console.log(`🎯 ${operations} usuarios +${POINTS_AMOUNT} pts (MAURO LIVE + SIN MAURO)`);
    }
  } catch (error) {
    console.error('❌ Error awardPoints:', error.message);
  }
}

/* ============= LIVE DETECCIÓN ============= */
async function isStreamLive() {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://kick.com/'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const live = data.livestream?.is_live === true;
      console.log(`📺 Mauro ${live ? '🔴 LIVE' : '⚫ OFFLINE'} | Kick viewers: ${data.viewer_count || 0}`);
      return live;
    }
  } catch (error) {
    console.log('🔄 Kick API fail');
  }

  const fallbackLive = viewersMap.size > 2;
  console.log(`📺 Fallback LIVE: ${fallbackLive} (${viewersMap.size} viewers SIN MAURO)`);
  return fallbackLive;
}

async function cleanupInactiveViewers() {
  const now = Date.now();
  const inactive = [];
  for (const [username, data] of viewersMap) {
    if (now - data.lastActivity > 10 * 60 * 1000) {
      inactive.push(username);
    }
  }
  inactive.forEach(username => viewersMap.delete(username));
  if (inactive.length > 0) {
    console.log(`🧹 Limpiados ${inactive.length} viewers inactivos (SIN MAURO)`);
  }
}

/* ============= API ENDPOINTS ============= */
app.get("/api/status", async (req, res) => {
  const live = await isStreamLive();
  const viewers = viewersMap.size;
  
  console.log(`📊 /status → Mauro LIVE: ${live} | Viewers: ${viewers} (SIN MAURO)`);
  
  res.json({ 
    status: "running", 
    viewers, 
    live, 
    channel: KICK_CHANNEL,
    timestamp: new Date().toISOString()
  });
});

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

/* ============= OAUTH - SIEMPRE FUNCIONA ============= */
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
    const tokenData = await fetch("https://id.kick.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: KICK_CLIENT_ID, client_secret: KICK_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      })
    }).then(r => r.json());

    const userData = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    }).then(r => r.json());

    const user = userData.data?.[0] || userData;
    const username = user.username || `kick_${user.id || Date.now()}`;
    
    console.log('✅ Usuario vinculado:', username);
    
    await db.collection('users').doc(username).set({
      kickId: user.id || 'unknown', username, avatar: user.profile_pic_url || '',
      points: 0, totalPointsEarned: 0, createdAt: new Date()
    }, { merge: true });

    const firebaseToken = await admin.auth().createCustomToken(`kick_${user.id || 'unknown'}`, {
      username, provider: "kick"
    });
    
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
  } catch (error) {
    console.error('❌ OAuth error:', error);
    res.redirect(`${FRONTEND_URL}?error=server`);
  }
});

/* ============= INTERVALS ============= */
setInterval(awardPoints, POINTS_INTERVAL);
setInterval(saveWatchtime, 5 * 60 * 1000);
setInterval(cleanupInactiveViewers, 2 * 60 * 1000);

app.listen(3000, () => {
  console.log("\n🚀 Gárgolas Backend LIVE ✅");
  console.log(`📺 ${KICK_CHANNEL}`);
  console.log(`✅ PUNTOS + WATCHTIME SOLO CUANDO MAURO LIVE`);
  console.log(`✅ MAUROOAKD EXCLUIDO de viewers/watchtime/puntos`);
  console.log(`✅ VINCULACIÓN SIEMPRE OK`);
});
