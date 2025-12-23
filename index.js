import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

/* 🔎 RUTA TEST */
app.get("/", (req, res) => {
  res.send("✅ Backend Gargolas funcionando");
});

const {
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  FRONTEND_URL
} = process.env;

/* LOGIN */
app.get("/auth/kick", (req, res) => {
  const url =
    "https://kick.com/oauth2/authorize" +
    "?response_type=code" +
    `&client_id=${KICK_CLIENT_ID}` +
    `&redirect_uri=${FRONTEND_URL}/callback.html` +
    "&scope=user:read";

  res.redirect(url);
});

/* CALLBACK */
app.get("/auth/kick/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) return res.send("❌ No code");

  try {
    const r = await fetch("https://kick.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
        redirect_uri: `${FRONTEND_URL}/callback.html`,
        code
      })
    });

    const data = await r.json();

    res.redirect(
      `${FRONTEND_URL}/callback.html?access_token=${data.access_token}`
    );

  } catch (e) {
    console.error(e);
    res.send("❌ Error OAuth");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🔥 Backend Kick activo en puerto " + PORT)
);
