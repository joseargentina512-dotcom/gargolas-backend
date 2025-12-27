/* ============= YA NO HAY LIMPIEZA AUTOMÁTICA ============= */
// Los usuarios se mantienen guardados en Firestore permanentemente

/* ============= GUARDAR WATCHTIME CADA 5 MIN ============= */
async function saveWatchtime() {
  try {
    if (viewersMap.size === 0) {
      console.log('⏱️ No hay usuarios viendo, nada que guardar');
      return;
    }

    const batch = db.batch();
    let saved = 0;

    for (const [username, data] of viewersMap.entries()) {
      const watchTimeSeconds = Math.floor((Date.now() - data.startTime) / 1000);
      const userRef = db.collection('watchtime').doc(username);
      
      batch.set(userRef, {
        username,
        watchTimeSeconds: admin.firestore.FieldValue.increment(watchTimeSeconds),
        totalWatchTime: admin.firestore.FieldValue.increment(watchTimeSeconds),
        lastUpdated: new Date(),
        sessions: admin.firestore.FieldValue.increment(1)
      }, { merge: true });

      saved++;
    }

    await batch.commit();
    console.log(`💾 Watchtime guardado para ${saved} usuarios`);

  } catch (error) {
    console.error('❌ Error guardando watchtime:', error.message);
  }
}

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
const POINTS_INTERVAL = 30 * 60 * 1000; // 30 minutos
const POINTS_AMOUNT = 50;

/* ============= FIREBASE ADMIN ============= */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(FIREBASE_SERVICE_ACCOUNT)
    )
  });
}

const db = admin.firestore();

/* ============= OAUTH STATE MEMORY ============= */
const sessions = new Map();

/* ============= TRACKER DE PUNTOS ============= */
// Map de usuarios viendo: { username: { startTime, lastActivity, sessionId, watchTimeSeconds } }
const viewersMap = new Map();
const WATCHTIME_SAVE_INTERVAL = 5 * 60 * 1000; // Guardar cada 5 minutos

/* ============= VERIFICAR SI STREAM ESTÁ LIVE ============= */
async function isStreamLive() {
  try {
    const response = await fetch(
      `https://kick.com/api/v2/channels/${KICK_CHANNEL}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        timeout: 5000
      }
    );

    if (!response.ok) {
      console.error(`⚠️ Error Kick API: ${response.status}`);
      return false;
    }

    const data = await response.json();
    const isLive = data?.livestream?.is_live || false;
    console.log(`📺 Stream ${KICK_CHANNEL}: ${isLive ? '🟢 LIVE' : '⚫ OFFLINE'}`);
    return isLive;
  } catch (error) {
    console.error('⚠️ Error verificando stream:', error.message);
    return false;
  }
}

/* ============= OTORGAR PUNTOS CADA 30 MIN ============= */
async function awardPoints() {
  try {
    if (viewersMap.size === 0) {
      console.log('⚠️ No hay usuarios viendo el stream');
      return;
    }

    const streamLive = await isStreamLive();
    if (!streamLive) {
      console.log('⚠️ Stream no está live, no se otorgan puntos');
      return;
    }

    const batch = db.batch();
    let updated = 0;

    // Otorgar puntos a cada usuario que esté viendo
    for (const [username] of viewersMap.entries()) {
      const userRef = db.collection('users').doc(username);
      
      batch.set(userRef, {
        points: admin.firestore.FieldValue.increment(POINTS_AMOUNT),
        watching: true,
        lastPointsUpdate: new Date(),
        totalPointsEarned: admin.firestore.FieldValue.increment(POINTS_AMOUNT)
      }, { merge: true });

      updated++;
      console.log(`✅ ${username} + ${POINTS_AMOUNT} puntos`);
    }

    await batch.commit();
    console.log(`\n🎯 ${updated} usuarios recibieron ${POINTS_AMOUNT} puntos\n`);

    // Registrar en historial
    await db.collection('pointsLog').add({
      timestamp: new Date(),
      channel: KICK_CHANNEL,
      usersRewarded: updated,
      pointsPerUser: POINTS_AMOUNT,
      totalPointsDistributed: updated * POINTS_AMOUNT
    });

  } catch (error) {
    console.error('❌ Error otorgando puntos:', error.message);
  }
}

/* ============= LIMPIAR USUARIOS INACTIVOS ============= */
async function cleanupInactiveViewers() {
  try {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutos sin actividad

    for (const [username, data] of viewersMap.entries()) {
      if (now - data.lastActivity > timeout) {
        viewersMap.delete(username);
        console.log(`🚪 ${username} removido por inactividad`);
      }
    }
  } catch (error) {
    console.error('❌ Error limpiando usuarios:', error.message);
  }
}

/* ============= LOGIN KICK ============= */
app.get("/auth/kick", (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const verifier = crypto.randomBytes(32).toString("hex");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    
    sessions.set(state, verifier);

    const params = new URLSearchParams({
      client_id: KICK_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "user:read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });

    const url = `https://id.kick.com/oauth/authorize?${params.toString()}`;
    
    console.log("🔗 Redirigiendo a Kick OAuth...");
    res.redirect(url);
  } catch (error) {
    console.error("❌ Error en /auth/kick:", error);
    res.redirect(`${FRONTEND_URL}?error=auth_error`);
  }
});

/* ============= CALLBACK - ARREGLADO ============= */
app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error } = req.query;

  // Verificar errores de Kick
  if (error) {
    console.error(`❌ Error de Kick: ${error}`);
    return res.redirect(`${FRONTEND_URL}?error=kick_denied`);
  }

  const verifier = sessions.get(state);
  if (!code || !verifier) {
    console.error("❌ Missing code o verifier");
    return res.redirect(`${FRONTEND_URL}?error=kick_auth`);
  }

  try {
    console.log("🔄 Intercambiando código por token...");

    // 1. OBTENER TOKEN
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
      }).toString()
    });

    if (!tokenRes.ok) {
      const errorData = await tokenRes.text();
      console.error("❌ Error obteniendo token:", tokenRes.status, errorData);
      return res.redirect(`${FRONTEND_URL}?error=token_error`);
    }

    const tokenData = await tokenRes.json();
    console.log("✅ Token obtenido:", tokenData.access_token.substring(0, 20) + "...");

    // 2. OBTENER INFO DEL USUARIO - ENDPOINT CORRECTO
    const userRes = await fetch("https://api.kick.com/public/v1/users", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      }
    });

    if (!userRes.ok) {
      const errorData = await userRes.text();
      console.error("❌ Error obteniendo usuario:", userRes.status, errorData);
      return res.redirect(`${FRONTEND_URL}?error=user_error`);
    }

    const kickUser = await userRes.json();
    console.log("✅ Usuario obtenido:", kickUser.username);

    // 3. CREAR TOKEN CUSTOM DE FIREBASE
    const firebaseToken = await admin.auth().createCustomToken(
      `kick_${kickUser.id}`,
      {
        username: kickUser.username,
        provider: "kick"
      }
    );

    console.log("✅ Token Firebase creado");

    // 4. GUARDAR USUARIO EN FIRESTORE
    await db.collection('users').doc(kickUser.username).set({
      kickId: kickUser.id,
      username: kickUser.username,
      avatar: kickUser.profile_pic,
      loginAt: new Date(),
      points: 0,
      totalPointsEarned: 0
    }, { merge: true });

    // Limpiar session
    sessions.delete(state);

    // REDIRIGIR CON TOKEN
    res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);

  } catch (error) {
    console.error("❌ Error en callback:", error.message);
    res.redirect(`${FRONTEND_URL}?error=server_error`);
  }
});

/* ============= RUTAS TRACKER ============= */

// Usuario comienza a ver el stream
app.post("/api/start-watching", async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "Username requerido" });
    }

    const streamLive = await isStreamLive();
    
    if (!streamLive) {
      return res.status(400).json({ 
        error: "El stream no está live en este momento",
        isLive: false
      });
    }

    // Agregar usuario a viewers
    viewersMap.set(username, {
      startTime: Date.now(),
      lastActivity: Date.now(),
      sessionId: Math.random().toString(36)
    });

    console.log(`👀 ${username} comenzó a ver (Total: ${viewersMap.size})`);

    res.json({
      success: true,
      message: `${username} está viendo a ${KICK_CHANNEL}`,
      totalViewers: viewersMap.size,
      nextRewardIn: Math.ceil(POINTS_INTERVAL / 1000 / 60) + " minutos"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Usuario deja de ver
app.post("/api/stop-watching", (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: "Username requerido" });
    }

    const wasViewing = viewersMap.has(username);
    viewersMap.delete(username);

    if (wasViewing) {
      console.log(`👋 ${username} dejó de ver (Total: ${viewersMap.size})`);
    }

    res.json({
      success: true,
      message: `${username} dejó de ver`,
      totalViewers: viewersMap.size
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Registrar actividad (user hace algo = sigue viendo)
app.post("/api/user-activity", (req, res) => {
  const { username } = req.body;

  if (viewersMap.has(username)) {
    viewersMap.get(username).lastActivity = Date.now();
    res.json({ success: true, message: "Actividad registrada" });
  } else {
    res.status(404).json({ error: "Usuario no está viendo" });
  }
});

// Estado actual
app.get("/api/status", async (req, res) => {
  const isLive = await isStreamLive();
  res.json({
    status: "running",
    streamLive: isLive,
    activeViewers: viewersMap.size,
    pointsRewardInterval: Math.ceil(POINTS_INTERVAL / 1000 / 60) + " minutos",
    pointsPerInterval: POINTS_AMOUNT,
    viewersList: Array.from(viewersMap.keys())
  });
});

// TOP WATCHTIME - PARA EL HTML
app.get("/api/top-watchtime", async (req, res) => {
  try {
    const snapshot = await db
      .collection("watchtime")
      .orderBy("totalWatchTime", "desc")
      .limit(10)
      .get();

    const topWatchtime = snapshot.docs.map((doc, idx) => ({
      position: idx + 1,
      username: doc.data().username,
      watchTimeSeconds: doc.data().totalWatchTime || 0,
      watchTimeHours: Math.floor((doc.data().totalWatchTime || 0) / 3600),
      watchTimeMinutes: Math.floor(((doc.data().totalWatchTime || 0) % 3600) / 60),
      isWatching: viewersMap.has(doc.data().username)
    }));

    res.json(topWatchtime);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🌟 DATOS DE PRUEBA - BORRAR DESPUÉS
app.get('/api/create-test-data', async (req, res) => {
  const testUsers = [
    { username: 'MauroAKD', totalWatchTime: 7200 },
    { username: 'Gargola1', totalWatchTime: 5400 },
    { username: 'Gargola2', totalWatchTime: 3600 },
    { username: 'TestUser', totalWatchTime: 1800 }
  ];
  
  const batch = db.batch();
  testUsers.forEach(user => {
    const docRef = db.collection('watchtime').doc(user.username);
    batch.set(docRef, {
      username: user.username,
      totalWatchTime: user.totalWatchTime,
      watchTimeSeconds: user.totalWatchTime
    });
  });
  
  await batch.commit();
  res.json({ success: true, message: '✅ Datos de prueba creados!' });
});

// Leaderboard (Puntos)
app.get("/api/leaderboard", async (req, res) => {
  try {
    const snapshot = await db
      .collection("users")
      .orderBy("points", "desc")
      .limit(10)
      .get();

    const leaderboard = snapshot.docs.map(doc => ({
      username: doc.id,
      points: doc.data().points || 0,
      isWatching: viewersMap.has(doc.id)
    }));

    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Puntos de un usuario
app.get("/api/user-points/:username", async (req, res) => {
  try {
    const { username } = req.params;
    const userRef = await db.collection("users").doc(username).get();

    if (!userRef.exists) {
      return res.json({ username, points: 0, watching: false });
    }

    res.json({
      username,
      points: userRef.data().points || 0,
      watching: viewersMap.has(username),
      totalEarned: userRef.data().totalPointsEarned || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ============= INICIAR PROCESOS ============= */

// Otorgar puntos cada 30 minutos
setInterval(awardPoints, POINTS_INTERVAL);

// Guardar watchtime cada 5 minutos
setInterval(saveWatchtime, WATCHTIME_SAVE_INTERVAL);

// Limpiar inactivos cada 2 minutos
setInterval(cleanupInactiveViewers, 2 * 60 * 1000);

// Verificar stream cada 1 minuto
setInterval(isStreamLive, 60 * 1000);

app.listen(3000, () => {
  console.log("\n🚀 Backend OK");
  console.log(`📺 Tracker de puntos para ${KICK_CHANNEL} activado`);
  console.log(`⏰ Puntos: ${POINTS_AMOUNT} cada ${POINTS_INTERVAL / 1000 / 60} minutos`);
  console.log(`🔗 OAuth: https://id.kick.com\n`);
});
