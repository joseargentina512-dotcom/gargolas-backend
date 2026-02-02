import express from "express";
import nodeFetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";

const app = express();

app.use(express.json());

app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","Content-Type");
  next();
});

const {
  KICK_CLIENT_ID,
  KICK_CLIENT_SECRET,
  FRONTEND_URL="http://localhost:3000",
  FIREBASE_SERVICE_ACCOUNT
} = process.env;

const REDIRECT_URI="https://gargolas-backend.onrender.com/auth/kick/callback";
const KICK_CHANNEL="maurooakd";

if(!admin.apps.length){
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
  });
}

const db = admin.firestore();
const viewersMap = new Map();

async function isStreamLive(){
  try{
    const r = await nodeFetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`);
    const d = await r.json();
    return d.livestream?.is_live === true;
  }catch{
    return false;
  }
}

app.post("/api/start-watching",(req,res)=>{
  const {username} = req.body;
  viewersMap.set(username,{last:Date.now()});
  res.json({success:true});
});

app.post("/api/redeem", async (req,res)=>{
  const {username,item,price} = req.body;

  const ref = db.collection("users").doc(username);
  const doc = await ref.get();

  if(!doc.exists)
    return res.json({success:false,error:"Usuario no existe"});

  const pts = doc.data().points || 0;

  if(pts < price)
    return res.json({success:false,error:"No tienes suficientes puntos"});

  await ref.update({
    points: admin.firestore.FieldValue.increment(-price)
  });

  const alert = `${username} canjeó ${item}`;

  await db.collection("redeems").add({
    username,item,price,alert,date:new Date()
  });

  res.json({success:true,alert});
});

app.post("/api/presente", async (req,res)=>{
  const {username} = req.body;

  const ref = db.collection("users").doc(username);
  const doc = await ref.get();

  const today = new Date().toISOString().split("T")[0];

  if(doc.exists && doc.data().lastPresente === today)
    return res.json({success:false,error:"Ya usaste hoy"});

  let streak = (doc.data()?.streak || 0) + 1;
  if(streak > 3) streak = 1;

  const bonus = 50 * streak;

  await ref.set({
    streak,
    lastPresente: today,
    points: admin.firestore.FieldValue.increment(bonus)
  },{merge:true});

  res.json({success:true,streak,bonusPoints:bonus});
});

app.get("/api/leaderboard", async (req,res)=>{
  const snap = await db.collection("users")
    .orderBy("points","desc")
    .limit(10)
    .get();

  res.json(snap.docs.map(d=>({
    username:d.id,
    points:d.data().points || 0
  })));
});

app.get("/auth/kick",(req,res)=>{
  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id:KICK_CLIENT_ID,
    redirect_uri:REDIRECT_URI,
    response_type:"code",
    scope:"user:read",
    state
  });

  res.redirect(`https://id.kick.com/oauth/authorize?${params}`);
});

app.get("/auth/kick/callback", async (req,res)=>{
  const {code} = req.query;

  const t = await nodeFetch("https://id.kick.com/oauth/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:KICK_CLIENT_ID,
      client_secret:KICK_CLIENT_SECRET,
      grant_type:"authorization_code",
      code,
      redirect_uri:REDIRECT_URI
    })
  });

  const tokenData = await t.json();

  const u = await nodeFetch("https://api.kick.com/api/v1/users",{
    headers:{Authorization:`Bearer ${tokenData.access_token}`}
  });

  const user = await u.json();
  const username = user.username;

  const uid = `kick_${user.id}`;

  try{
    await admin.auth().getUser(uid);
  }catch{
    await admin.auth().createUser({
      uid,
      displayName:username
    });
  }

  await db.collection("users").doc(username).set({
    points:0,
    streak:0
  },{merge:true});

  const firebaseToken = await admin.auth().createCustomToken(uid);

  res.redirect(`${FRONTEND_URL}?token=${firebaseToken}`);
});

setInterval(async ()=>{
  if(!(await isStreamLive())) return;

  for(const username of viewersMap.keys()){
    await db.collection("users").doc(username).set({
      points: admin.firestore.FieldValue.increment(50)
    },{merge:true});
  }

  console.log("Puntos entregados a viewers activos");

},30*60*1000);

app.listen(process.env.PORT || 3000,()=>{
  console.log("Backend Gárgolas Online");
});
