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

/* ============= FIREBASE ADMIN ============= */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(FIREBASE_SERVICE_ACCOUNT)
    )
  });
}

/* ============= OAUTH STATE MEMORY ============= */
const sessions = new Map();

/* ============= LOGIN KICK ============= */
app.get("/auth/kick", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  sessions.set(state, verifier);

  const url =
    "https://id.kick.com/oauth/authorize?" +
    new URLSearchParams({
      client_id: KICK_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "user:read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });

  res.redirect(url);
});

/* ============= CALLBACK ============= */
app.get("/auth/kick/callback", async (req, res) => {
  const { code, state } = req.query;
  const verifier = sessions.get(state);

  if (!code || !verifier) {
    return res.redirect(`${FRONTEND_URL}?error=kick_auth`);
  }

  try {
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

    const token = await tokenRes.json();

    const userRes = await fetch("https://kick.com/api/v2/user", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    const kickUser = await userRes.json();

    const firebaseToken = await admin
      .auth()
      .createCustomToken(`kick_${kickUser.id}`, {
        username: kickUser.username
      });

    res.redirect(
      `${FRONTEND_URL}?token=${firebaseToken}`
    );
  } catch (e) {
    console.error(e);
    res.redirect(`${FRONTEND_URL}?error=server`);
  }
});

app.listen(3000, () => console.log("Backend OK"));
