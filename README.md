# AKANDO AI — Student Chat Website

Student-der jonno Muse-er moto chat website. Student-ra site-e registration
korbe, Billah (admin) approve korbe, tarpor login kore chat korte parbe.
Reply AKANDO AI background-e dey — kono external API, key ba khoroch nai.

## Chalano (Run)

```bash
cd ~/workspace/akando-site
./venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Tarpor browser-e kholo: `http://localhost:8000` (server-e chalale server-er IP/hostname).

> Prothom run-e SQLite database (`akando.db`) nije thekei toiri hoy,
> ar admin account seed hoy.

## Admin login

- **Mobile:** `01700000000`
- **Password:** `akando-admin`

⚠️ **Prothom login-er porei password bodle nao!** Admin panel-e
"🔑 Password bodlan" section-e giye purono + notun password dao.

Kivabe kaj kore:
1. Student **Registration** kore (nam, mobile, password) → account **PENDING** thake.
2. Tumi admin panel-e (⚙️ Admin panel link, shudhu admin dekhte pare)
   pending list-e **Approve ✓** chap dao → student chat korte pare.
3. **Reject ✕** chap dile se ar dhukte parbe na.

## Background reply pipeline (kivabe uttor ashe)

Site-ta nije reply likhe na — AKANDO AI background worker likhe:

1. Student message pathale backend `~/workspace/akando-bot/site_inbox.jsonl`-e
   ekta line lekhe:
   `{"channel":"site","site_user_id":..,"name":"..","text":"..","ts":..,"msg_local_id":".."}`
2. Background worker oi file watch kore, uttor toiri kore
   `~/workspace/akando-bot/site_outbox.jsonl`-e lekhe:
   `{"msg_local_id":"..","text":".."}`
3. App-er vitore ekta **poller thread** (startup-e chalu hoy) proti 2 second-e
   outbox file check kore, reply database-e dhukiye dey.
4. Frontend proti 2 second-e `GET /api/chats/{id}/messages` poll kore —
   reply aslei chat-e dekhay. Reply na asha porjonto **"AKANDO AI likhche…"**
   typing indicator dekhay.

## Hosting note (student-ra internet diye dhukbe kivabe)

App-ta ekhon ei server-e chole. Student-der nijer phone/PC theke dhukte hole
site-tar ekta **public URL** lagbe — mane hosting lagbe.

### ✅ Recommended: Render (free, permanent, card lage na) — Billah-r choice

**Tumi ja korba (5 minute):**
1. https://render.com -e **Sign Up** koro (GitHub diye login sobcheye shohoj).
2. Dashboard-e **New → Blueprint** chap dao.
3. Ei project-er GitHub repo connect koro (repo-te `render.yaml` age thekei ache).
4. **Apply** chap dao — Render nije build kore deploy kore dibe (~5 min).
5. Deploy shesh hole ekta free URL paba, jemon `https://akando-ai.onrender.com`.

**Tarpor amake dao:**
- Site-er URL (jemon `https://akando-ai.onrender.com`)
- Render dashboard → service → **Environment** theke `WORKER_SECRET`-er value

Ei duto pele ami background worker-ke hosted site-er sathe connect kore dibo —
student message pathale uttor background thekei ashbe (`/api/worker/pending` +
`/api/worker/reply` endpoint diye, secret header diye secured).

**Jene rakho (free tier-er limit):**
- 15 minute keu na dhukle service ghumiye jay — porer visitor-er prothom
  load-e 30–60 second lagte pare. Eta free plan-er niyom.
- Database SQLite file-e thake; Render free-te redeploy hole data reset hote
  pare. Student barle pore paid database-e niye jabo.

### Alternative option
- **VPS (Hetzner/Contabo/DO, ~$4–6/mo):** full control, kokhono ghumay na.
  Pore upgrade korte chaile ami migrate kore dibo.
3. **Billah-r nijer PC/server:** PC 24/7 on rakhle Cloudflare Tunnel diye
   free-te public URL pawa jay (kono port-forwarding lagena).

Database SQLite file-ei thake (`akando.db`) — backup nite chaile oi file-ta
copy korlei hobe. Ekhono kono hosting-e kichu sign-up ba deploy kora hoyni —
siddhanto Billah nibe.

## Security notes

- Password kokhono plaintext-e thakena — PBKDF2-HMAC-SHA256 hash (stdlib).
- Login session token HttpOnly cookie-te thake, 7 din meyad.
- Prottek user shudhu nijer chat dekhte pare (per-user isolation).
- Pending user approve na howa porjonto chat korte parena.
- Admin panel shudhu admin account dekhte pare.
