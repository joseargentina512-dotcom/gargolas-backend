import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  FRONTEND_URL,
  PORT
} = process.env;

// === RUTA LOGIN (redirige a Kick) ===
app.get("/auth/kick", (req, res) => {
  const redirectUri = encodeURIComponent(`https://${req.headers.host}/auth/kick/callback`);
  const url = `https://kick.com/oauth2/authorize?client_id=${KICK_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=user:read`;
  res.redirect(url);
});

// === CALLBACK (Kick devuelve code) ===
app.get("/auth/kick/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("Error: no se recibió code");

  try {
    const tokenRes = await fetch("https://kick.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
        redirect_uri: `https://${req.headers.host}/auth/kick/callback`,
        code
      })
    });

    const tokenData = await tokenRes.json();

    // Redirige al frontend con access_token
    res.redirect(`${FRONTEND_URL}/callback.html?access_token=${tokenData.access_token}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth error");
  }
});

app.listen(PORT || 3000, () =>
  console.log(`🔥 Backend Kick activo en puerto ${PORT || 3000}`)
);
