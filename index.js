import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const {
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  FRONTEND_URL
} = process.env;

/* ===============================
   LOGIN → REDIRECCIONA A KICK
================================ */
app.get("/auth/kick", (req, res) => {
  const redirect = `https://kick.com/oauth2/authorize?response_type=code&client_id=${KICK_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    FRONTEND_URL + "/callback.html"
  )}&scope=user:read`;

  res.redirect(redirect);
});

/* ===============================
   CALLBACK → INTERCAMBIA TOKEN
================================ */
app.get("/auth/kick/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("No code");
  }

  try {
    const tokenRes = await fetch("https://kick.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
        redirect_uri: FRONTEND_URL + "/callback.html",
        code
      })
    });

    const tokenData = await tokenRes.json();

    res.redirect(
      `${FRONTEND_URL}/callback.html?access_token=${tokenData.access_token}`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth error");
  }
});

app.listen(3000, () =>
  console.log("🔥 Backend Kick activo en puerto 3000")
);
