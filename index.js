import express from "express";
import nodeFetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";
import cors from "cors"; // Usamos el middleware oficial de CORS

const app = express();

// --- CONFIGURACIÓN ---
const {
    KICK_CLIENT_ID,
    KICK_CLIENT_SECRET,
    FRONTEND_URL = "http://localhost:3000",
    FIREBASE_SERVICE_ACCOUNT,
    PORT = 3000
} = process.env;

const REDIRECT_URI = "https://gargolas-backend.onrender.com/auth/kick/callback";
const KICK_CHANNEL = "maurooakd";

// 🔥 INICIALIZAR FIREBASE
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
    });
}

const db = admin.firestore();
const viewersMap = new Map(); // Almacena { username: timestamp }

// --- MIDDLEWARES ---
app.use(express.json());
app.use(cors({ origin: FRONTEND_URL })); // Solo tu web puede consultar este backend

// ================= UTILIDADES =================

async function isStreamLive() {
    try {
        // Tip: La API interna de Kick a veces cambia, asegúrate de tener permisos actualizados
        const r = await nodeFetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`);
        const d = await r.json();
        return d.livestream?.is_live === true;
    } catch (err) {
        console.error("Error comprobando stream:", err.message);
        return false;
    }
}

// ================= ENDPOINTS =================

// Activa el tracking de puntos
app.post("/api/start-watching", (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false });

    // Actualizamos el "last seen" del usuario
    viewersMap.set(username, Date.now());
    res.json({ success: true });
});

// Canje de premios
app.post("/api/redeem", async (req, res) => {
    try {
        const { username, item, price } = req.body;
        const ref = db.collection("users").doc(username);
        
        // Transacción atómica para evitar errores de saldo negativo
        await db.runTransaction(async (t) => {
            const doc = await t.get(ref);
            if (!doc.exists) throw "Usuario no encontrado";
            
            const currentPoints = doc.data().points || 0;
            if (currentPoints < price) throw "Saldo insuficiente";

            t.update(ref, { points: admin.firestore.FieldValue.increment(-price) });
            
            const redeemRef = db.collection("redeems").doc();
            t.set(redeemRef, {
                username, item, price,
                status: "pending",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({ success: true, alert: `¡Solicitud de ${item} enviada!` });
    } catch (err) {
        res.status(400).json({ success: false, error: err });
    }
});

// Sistema de Presente con Racha Mejorada
app.post("/api/presente", async (req, res) => {
    try {
        const { username } = req.body;
        const ref = db.collection("users").doc(username);
        const doc = await ref.get();

        const now = new Date();
        const todayStr = now.toISOString().split("T")[0];
        
        if (doc.exists && doc.data().lastPresente === todayStr) {
            return res.status(400).json({ success: false, error: "Ya reclamaste tu recompensa diaria." });
        }

        let streak = 1;
        if (doc.exists && doc.data().lastPresente) {
            const lastDate = new Date(doc.data().lastPresente);
            const diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
            
            if (diffDays === 1) {
                streak = (doc.data().streak || 0) + 1;
                if (streak > 7) streak = 7; // Máximo multiplicador x7
            }
        }

        const bonus = 100 * streak; // 100 base x racha

        await ref.set({
            streak,
            lastPresente: todayStr,
            points: admin.firestore.FieldValue.increment(bonus)
        }, { merge: true });

        res.json({ success: true, streak, bonusPoints: bonus });
    } catch (err) {
        res.status(500).json({ success: false, error: "Error en el servidor" });
    }
});

// Leaderboard optimizado (Cacheable)
app.get("/api/leaderboard", async (req, res) => {
    try {
        const snap = await db.collection("users")
            .orderBy("points", "desc")
            .limit(10)
            .get();

        const leaderboard = snap.docs.map(d => ({
            username: d.id,
            points: d.data().points || 0
        }));
        res.json(leaderboard);
    } catch (err) {
        res.status(500).json({ error: "No se pudo cargar el ranking" });
    }
});

// ================= OAUTH KICK =================

app.get("/auth/kick", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
        client_id: KICK_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "user:read",
        state
    });
    res.redirect(`https://id.kick.com/oauth/authorize?${params}`);
});

app.get("/auth/kick/callback", async (req, res) => {
    try {
        const { code } = req.query;

        const tokenRes = await nodeFetch("https://id.kick.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: KICK_CLIENT_ID,
                client_secret: KICK_CLIENT_SECRET,
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT_URI
            })
        });

        const tokenData = await tokenRes.json();
        
        const userRes = await nodeFetch("https://api.kick.com/api/v1/users", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });

        const userData = await userRes.json();
        const user = userData.data?.[0];

        if (!user) throw new Error("Usuario no encontrado en Kick");

        const username = user.username;
        const uid = `kick_${user.id}`;

        // Asegurar usuario en Firebase
        try {
            await admin.auth().getUser(uid);
        } catch {
            await admin.auth().createUser({ uid, displayName: username });
        }

        // Inicializar perfil en Firestore si es nuevo
        const userRef = db.collection("users").doc(username);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            await userRef.set({
                points: 0,
                streak: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        const firebaseToken = await admin.auth().createCustomToken(uid);
        res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);

    } catch (err) {
        console.error("Auth Error:", err);
        res.redirect(`${FRONTEND_URL}?error=auth_failed`);
    }
});

// ================= LOOP DE PUNTOS (BACKGROUND) =================

setInterval(async () => {
    try {
        if (!(await isStreamLive())) {
            // Si el stream cae, podemos limpiar el mapa para ahorrar memoria
            viewersMap.clear();
            return;
        }

        const now = Date.now();
        const batch = db.batch();
        let hasUpdates = false;

        for (const [username, lastSeen] of viewersMap.entries()) {
            // Si el usuario no ha enviado un "start-watching" en los últimos 35 min, lo sacamos
            if (now - lastSeen > 35 * 60 * 1000) {
                viewersMap.delete(username);
                continue;
            }

            const ref = db.collection("users").doc(username);
            batch.set(ref, { points: admin.firestore.FieldValue.increment(50) }, { merge: true });
            hasUpdates = true;
        }

        if (hasUpdates) {
            await batch.commit();
            console.log(`[${new Date().toLocaleTimeString()}] 50 puntos entregados a los guerreros activos.`);
        }
    } catch (err) {
        console.error("Error en loop de puntos:", err);
    }
}, 30 * 60 * 1000); // Cada 30 minutos

// ================= INICIO =================
app.listen(PORT, () => {
    console.log(`>>> Gárgolas Backend subiendo en puerto ${PORT}`);
});
