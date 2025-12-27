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

/* ============= FUNCIONES COMPLETAS - CON LOGS DE ERROR ============= */
async function saveWatchtime() {
  if (viewersMap.size === 0) {
    console.log('❌ ERROR: No hay viewers conectados - Skip watchtime');
    return;
  }

  try {
    const batch = db.batch();
    let operations = 0;

    for (const [username, data] of viewersMap.entries()) {
      const secs = Math.floor((Date.now() - data.startTime) / 1000);
      batch.set(db.collection('watchtime').doc(username), {
        username,
        totalWatchTime: admin.firestore.FieldValue.increment(secs),
        watchTimeSeconds: admin.firestore.FieldValue.increment(secs),
        lastUpdated: new Date()
      }, { merge: true });
      operations++;
    }

    if (operations > 0) {
      await batch.commit();
      console.log(`💾 Watchtime OK: ${operations} usuarios`);
    }
  } catch (error) {
    console.error('❌ Error saveWatchtime:', error.message);
  }
}

/* ============= API STATUS CORREGIDO - DETECTA STREAM LIVE ============= */
async function isStreamLive() {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`);
    if (!res.ok) {
      console.error('❌ Kick API no OK:', res.status);
      return false;
    }
    
    const data = await res.json();
    const isLive = data.livestream?.is_live === true || 
                   data.livestream?.live_at !== null ||
                   data.is_live === true;
    
    console.log(`📺 ${KICK_CHANNEL}: Live=${isLive}, ViewersAPI=${data.viewer_count || 'N/A'}`);
    return isLive;
  } catch (error) {
    console.error('❌ Kick API error:', error.message);
    return false;
  }
}

async function awardPoints() {
  if (viewersMap.size === 0) {
    console.log('❌ ERROR: No hay viewers conectados - Skip puntos');
    return;
  }
  
  if (!await isStreamLive()) {
    console.log('❌ ERROR: Stream offline - Skip puntos');
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
      console.log(`🎯 ${operations} usuarios +${POINTS_AMOUNT} pts`);
    }
  } catch (error) {
    console.error('❌ Error awardPoints:', error.message);
  }
}

async function cleanupInactiveViewers() {
  const now = Date.now();
  const inactive = [];
  for (const [username, data] of viewersMap) {
    if (now - data.lastActivity > 5 * 60 * 1000) {
      inactive.push(username);
    }
  }
  inactive.forEach(username => viewersMap.delete(username));
  if (inactive.length > 0) {
    console.log(`🧹 Limpiados ${inactive.length} viewers (solo memoria)`);
  }
}

/* ============= RUTAS OAUTH ============= */
app.get("/auth/kick", async (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  
  await saveSession(state, verifier);
  
  const params = new URLSearchParams({
    client_id: KICK_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: "code", scope: "user:read", state,
    code_challenge: challenge, code_challenge_method: "S256"
  });
  
  res.redirect(`https://id.kick.com/oauth/authorize?${params}`);
});

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.redirect(`${FRONTEND_URL}?error=auth`);

  const verifier = await getSession(state);
  if (!verifier) return res.redirect(`${FRONTEND_URL}?error=state`);

  try {
    const tokenRes = await fetch("https://id.kick.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: KICK_CLIENT_ID, client_secret: KICK_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      })
    });
    
    const tokenData = await tokenRes.json();
    const userRes = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    });
    
    const userData = await userRes.json();
    const user = userData.data?.[0] || userData;
    const username = user.username || `kick_${user.id || Date.now()}`;
    
    const firebaseToken = await admin.auth().createCustomToken(`kick_${user.id || 'unknown'}`, {
      username, provider: "kick"
    });
    
    await db.collection('users').doc(username).set({
      kickId: user.id || 'unknown', username, avatar: user.profile_pic_url || '',
      points: 0, totalPointsEarned: 0
    }, { merge: true });
    
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
  } catch (error) {
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?error=server`);
  }
});

/* ============= API RUTAS ============= */
app.post("/api/start-watching", async (req, res) => {
  const { username } = req.body;
  if (username) {
    viewersMap.set(username, { startTime: Date.now(), lastActivity: Date.now() });
    console.log(`👀 ${username} viendo (${viewersMap.size})`);
  }
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/stop-watching", (req, res) => {
  const { username } = req.body;
  if (username) viewersMap.delete(username);
  res.json({ success: true });
});

app.post("/api/user-activity", (req, res) => {
  const { username } = req.body;
  if (viewersMap.has(username)) viewersMap.get(username).lastActivity = Date.now();
  res.json({ success: true });
});

app.get("/api/status", async (req, res) => {
  const live = await isStreamLive();
  console.log(`📊 API/status: Live=${live} | Memoria=${viewersMap.size}`);
  
  res.json({ 
    status: "running", 
    viewers: viewersMap.size, 
    live: live,
    channel: KICK_CHANNEL,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/top-watchtime", async (req, res) => {
  const snapshot = await db.collection("watchtime").orderBy("totalWatchTime", "desc").limit(10).get();
  res.json(snapshot.docs.map((doc, i) => {
    const d = doc.data();
    return {
      position: i + 1,
      username: d.username,
      hours: Math.floor((d.totalWatchTime || 0) / 3600),
      minutes: Math.floor(((d.totalWatchTime || 0) % 3600) / 60),
      watching: viewersMap.has(d.username)
    };
  }));
});

app.get("/api/leaderboard", async (req, res) => {
  const snapshot = await db.collection("users").orderBy("points", "desc").limit(10).get();
  res.json(snapshot.docs.map(doc => ({
    username: doc.id, points: doc.data().points || 0, watching: viewersMap.has(doc.id)
  })));
});

/* ============= INTERVALS ============= */
setInterval(awardPoints, POINTS_INTERVAL);
setInterval(saveWatchtime, 5 * 60 * 1000);
setInterval(cleanupInactiveViewers, 2 * 60 * 1000);

app.listen(3000, () => {
  console.log("\n🚀 Gárgolas Backend LIVE ✅");
  console.log(`📺 ${KICK_CHANNEL} - ${POINTS_AMOUNT}pts/30min`);
  console.log(`✅ Batch fix + Logs ERROR + API STATUS FIX + Top PERMANENTE`);
});
