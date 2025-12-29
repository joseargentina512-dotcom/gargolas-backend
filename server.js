import express from "express";
import nodeFetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

const {
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  FRONTEND_URL = "http://localhost:3000",
  FIREBASE_SERVICE_ACCOUNT
} = process.env;

const REDIRECT_URI = "https://gargolas-backend.onrender.com/auth/kick/callback";
const KICK_CHANNEL = "maurooakd";
const POINTS_INTERVAL = 30 * 60 * 1000;
const POINTS_AMOUNT = 50;

if (!admin.apps.length && FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
    });
    console.log("✅ Firebase inicializado");
  } catch (error) {
    console.error("❌ Firebase error:", error.message);
  }
}

const db = admin.firestore();
const viewersMap = new Map();

// SESSION MANAGEMENT
async function saveSession(state, verifier) {
  await db.collection('oauth_sessions').doc(state).set({
    verifier, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
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
    console.error("Session error:", error);
    return null;
  }
}

async function deleteSession(state) {
  try {
    await db.collection('oauth_sessions').doc(state).delete();
  } catch (error) {
    console.error("Delete session error:", error);
  }
}

// ✅ KICK API CORREGIDA
async function isStreamLive() {
  try {
    const response = await nodeFetch(`https://ingest.kick.com/api/v1/channels/${KICK_CHANNEL}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    
    const data = await response.json();
    const live = data.is_live || false;
    const viewers = data.viewer_count || 0;
    
    console.log(`📺 ${KICK_CHANNEL}: ${live ? '🔴 LIVE' : '⚫ OFFLINE'} (${viewers} viewers)`);
    return { live, viewers };
  } catch (error) {
    console.error('❌ Kick API error:', error.message);
    return { live: false, viewers: 0 };
  }
}

// VIEWER ENDPOINTS
app.post("/api/start-watching", async (req, res) => {
  const { username } = req.body;
  
  if (!username || username.toLowerCase() === 'maurooakd') {
    return res.json({ success: true, viewers: viewersMap.size, excluded: true });
  }

  viewersMap.set(username, { startTime: Date.now(), lastActivity: Date.now() });
  console.log(`👀 +${username} (${viewersMap.size} viewers)`);
  res.json({ success: true, viewers: viewersMap.size });
});

app.post("/api/stop-watching", (req, res) => {
  const { username } = req.body;
  if (username && viewersMap.has(username)) {
    viewersMap.delete(username);
    console.log(`👋 -${username} (${viewersMap.size} viewers)`);
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

// STATUS API
app.get("/api/status", async (req, res) => {
  const status = await isStreamLive();
  res.json({
    live: status.live,
    viewers: viewersMap.size,
    channel: KICK_CHANNEL,
    totalViewers: status.viewers || 0
  });
});

// LEADERBOARDS
app.get("/api/top-watchtime", async (req, res) => {
  try {
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
  } catch (error) {
    res.status(500).json({ error: "Leaderboard error" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const snapshot = await db.collection("users")
      .orderBy("points", "desc")
      .limit(10)
      .get();
      
    res.json(snapshot.docs.map(doc => ({
      username: doc.id,
      points: doc.data().points || 0,
      watching: viewersMap.has(doc.id)
    })));
  } catch (error) {
    res.status(500).json({ error: "Leaderboard error" });
  }
});

// OAUTH KICK - CORREGIDO
app.get("/auth/kick", async (req, res) => {
  if (!KICK_CLIENT_ID) {
    return res.redirect(`${FRONTEND_URL}?error=no_client_id`);
  }

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
});

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error } = req.query;
  
  if (error || !code || !state) {
    return res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }

  const verifier = await getSession(state);
  if (!verifier) {
    return res.redirect(`${FRONTEND_URL}?error=invalid_state`);
  }

  try {
    // ✅ FIX: body como string
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
      }).toString()
    });
    
    const tokenData = await tokenRes.json();
    
    if (!tokenData.access_token) {
      throw new Error("No access token");
    }
    
    const userRes = await nodeFetch("https://api.kick.com/api/v1/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    });
    
    const userData = await userRes.json();
    const user = userData.data?.[0] || userData;
    const username = user.username || `kick_${user.id}`;
    
    // Save user
    await db.collection('users').doc(username).set({
      kickId: user.id,
      username,
      avatar: user.profile_pic_url || '',
      points: 0,
      totalPointsEarned: 0,
      createdAt: new Date()
    }, { merge: true });

    const firebaseToken = await admin.auth().createCustomToken(
      `kick_${user.id}`, 
      { username, provider: "kick" }
    );
    
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
  } catch (error) {
    console.error('❌ OAuth error:', error.message);
    await deleteSession(state);
    res.redirect(`${FRONTEND_URL}?error=oauth_failed`);
  }
});

// INTERVALS
setInterval(async () => {
  const status = await isStreamLive();
  if (status.live && viewersMap.size > 0) {
    console.log(`🎯 Awarding points to ${viewersMap.size} viewers`);
    // Points logic aquí (simplificado)
  }
}, POINTS_INTERVAL);

setInterval(() => {
  const now = Date.now();
  for (const [username, data] of viewersMap) {
    if (now - data.lastActivity > 10 * 60 * 1000) {
      viewersMap.delete(username);
    }
  }
}, 2 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend en puerto ${PORT}`);
  console.log(`📺 Monitoreando ${KICK_CHANNEL}`);
});
