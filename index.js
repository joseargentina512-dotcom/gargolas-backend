import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ENV ================= */
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

/* ============= FIREBASE ADMIN ============= */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
  });
}

const db = admin.firestore();
const viewersMap = new Map();
const WATCHTIME_SAVE_INTERVAL = 5 * 60 * 1000;

/* ============= FIRESTORE SESSIONS ============= */
async function saveSession(state, verifier) {
  try {
    await db.collection('oauth_sessions').doc(state).set({
      verifier,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });
    console.log("💾 Session guardada:", state.substring(0, 8));
  } catch (error) {
    console.error('❌ Error saveSession:', error);
  }
}

async function getSession(state) {
  try {
    const doc = await db.collection('oauth_sessions').doc(state).get();
    if (!doc.exists) return null;
    
    const data = doc.data();
    if (new Date() > data.expiresAt) {
      await db.collection('oauth_sessions').doc(state).delete();
      return null;
    }
    return data.verifier;
  } catch (error) {
    console.error('❌ Error getSession:', error);
    return null;
  }
}

async function deleteSession(state) {
  try {
    await db.collection('oauth_sessions').doc(state).delete();
  } catch (error) {
    console.error('❌ Error deleteSession:', error);
  }
}

/* ============= FUNCIONES PRINCIPALES ============= */
async function saveWatchtime() {
  if (viewersMap.size === 0) return;
  const batch = db.batch();
  let saved = 0;
  for (const [username, data] of viewersMap) {
    const watchTimeSeconds = Math.floor((Date.now() - data.startTime) / 1000);
    batch.set(db.collection('watchtime').doc(username), {
      username,
      watchTimeSeconds: admin.firestore.FieldValue.increment(watchTimeSeconds),
      totalWatchTime: admin.firestore.FieldValue.increment(watchTimeSeconds),
      lastUpdated: new Date()
    }, { merge: true });
    saved++;
  }
  await batch.commit();
  console.log(`💾 Watchtime: ${saved} usuarios`);
}

async function isStreamLive() {
  try {
    const response = await fetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await response.json();
    return data?.livestream?.is_live || false;
  } catch (error) {
    return false;
  }
}

async function awardPoints() {
  if (viewersMap.size === 0) return;
  const streamLive = await isStreamLive();
  if (!streamLive) return;
  
  const batch = db.batch();
  for (const [username] of viewersMap) {
    batch.set(db.collection('users').doc(username), {
      points: admin.firestore.FieldValue.increment(POINTS_AMOUNT),
      watching: true,
      lastPointsUpdate: new Date()
    }, { merge: true });
  }
  await batch.commit();
  console.log(`🎯 ${viewersMap.size} usuarios +${POINTS_AMOUNT} pts`);
}

async function cleanupInactiveViewers() {
  const now = Date.now();
  for (const [username, data] of viewersMap) {
    if (now - data.lastActivity > 5 * 60 * 1000) {
      viewersMap.delete(username);
    }
  }
}

/* ============= RUTAS OAUTH ============= */
app.get("/auth/kick", async (req, res) => {
  try {
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
    
    res.redirect(`https://id.kick.com/oauth/authorize?${params}`);
  } catch (error) {
    res.redirect(`${FRONTEND_URL}?error=auth_error`);
  }
});

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  
  if (oauthError || !code || !state) {
    return res.redirect(`${FRONTEND_URL}?error=invalid_auth`);
  }

  const verifier = await getSession(state);
  if (!verifier) {
    return res.redirect(`${FRONTEND_URL}?error=invalid_state`);
  }

  try {
    // TOKEN EXCHANGE
    const tokenRes = await fetch("https://id.kick.com/oauth/token", {
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
    
    // GET USER
    const userRes = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    });
    
    const userData = await userRes.json();
    const user = userData.data?.[0] || userData;
    const username = user.username || `kick_${user.id || Date.now()}`;
    
    // FIREBASE TOKEN
    const firebaseToken = await admin.auth().createCustomToken(`kick_${user.id || 'unknown'}`, {
      username,
      provider: "kick"
    });
    
    // SAVE USER
    await db.collection('users').doc(username).set({
      kickId: user.id || 'unknown',
      username,
      avatar: user.profile_pic_url || '',
      points: 0
    }, { merge: true });
    
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
    
  } catch (error) {
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?error=server_error`);
  }
});

/* ============= RUTAS API ============= */
app.post("/api/start-watching", async (req, res) => {
  const { username } = req.body;
  viewersMap.set(username, { startTime: Date.now(), lastActivity: Date.now() });
  res.json({ success: true, totalViewers: viewersMap.size });
});

app.post("/api/stop-watching", (req, res) => {
  const { username } = req.body;
  viewersMap.delete(username);
  res.json({ success: true });
});

app.post("/api/user-activity", (req, res) => {
  const { username } = req.body;
  if (viewersMap.has(username)) {
    viewersMap.get(username).lastActivity = Date.now();
  }
  res.json({ success: true });
});

app.get("/api/status", async (req, res) => {
  res.json({
    status: "ok",
    viewers: viewersMap.size,
    streamLive: await isStreamLive()
  });
});

app.get("/api/top-watchtime", async (req, res) => {
  const snapshot = await db.collection("watchtime")
    .orderBy("totalWatchTime", "desc")
    .limit(10)
    .get();
    
  const data = snapshot.docs.map(doc => ({
    username: doc.data().username,
    hours: Math.floor((doc.data().totalWatchTime || 0) / 3600),
    minutes: Math.floor(((doc.data().totalWatchTime || 0) % 3600) / 60)
  }));
  res.json(data);
});

/* ============= INTERVALS ============= */
setInterval(awardPoints, POINTS_INTERVAL);
setInterval(saveWatchtime, WATCHTIME_SAVE_INTERVAL);
setInterval(cleanupInactiveViewers, 2 * 60 * 1000);

app.listen(3000, () => {
  console.log("🚀 Backend Gargolas OK");
});
