# Evidenca vzdrževanja vozila

> **Ta mapa (`car-maintenance-app-firebase`):** podatki so v **Firebase Firestore** (ne v `localStorage` za evidenco). Pred prvim zagonom nastavi `firebase-config.js` in pravila Firestore. Navodila: **`FIREBASE-NETLIFY.md`**. Tema in povečava še vedno uporabljata `localStorage`.

Breznamestitvena spletna aplikacija za spremljanje vozil, planov vzdrževanja in zgodovine servisov (vmesnik v slovenščini).

### Zasnova (v2)

- **Svetlo / temno ozadje** – gumb prikaže *Temno ozadje* ali *Svetlo ozadje* glede na trenutno izbiro; nastavitev v `localStorage`.
- Spustni seznam **velikosti prikaza** neposredno pod gumbom za ozadje: 100 % (privzeto), 125 %, 150 %, 175 %, 200 %; shranjeno v `localStorage` (`car-maintenance-zoom`).
- **Stranski meni** (Vozila · Načrti vzdrževanja · Servisni zapisi · Pregled Evidence) – vsebina ni več v enem dolgem stolpcu.
- **Vozila:** obrazec in seznam **v dveh stolpcih** (na manjših zaslonih pod drugim); zgoraj **e-Vinjeta** – izbira vozila, gumb **Preveri vinjeto** odpre modal z vgrajenim portalom DARS (iframe), indikatorjem nalaganja in gumbom **Zapri**; obrazec **Esc** / klik na ozadje zapre modal. Obstaja še povezava za odpiranje DARS v novem zavihku, če stran ne dovoli vgradnje (`X-Frame-Options`).
- **Pregled Evidence:** zapadlost in zgodovina **side-by-side**; **desno** graf: ocena vrednosti vozila (referenčna cena ali informativna ocena) in **skupaj vneseni stroški servisa**; povezavi za **avto.net** in **mobile.de** (prava tržna cena ni v aplikaciji – primerjava ročno na portalih).
- Svetla, minimalistična paleta, pisava **DM Sans** (Google Fonts).

Staro enostavno postavitev (samo stolpec) je shranjena v mapi **`archive/classic-design/`**.

## Zagon

1. Odpri `index.html` v brskalniku.
2. Dodaj vozilo.
3. Dodaj plane vzdrževanja in servisne zapise.

## Zaščita na Vercel (prek `.env`)

Aplikacija nima več vgrajenega (client-side) gesla v JavaScript kodi. Za produkcijo na Vercel uporabi **HTTP Basic Auth** prek `middleware.js` in okolijskih spremenljivk:

1. V Vercel projektu odpri **Settings → Environment Variables**.
2. Dodaj:
   - `APP_BASIC_AUTH_USER`
   - `APP_BASIC_AUTH_PASS`
3. Nastavi močno, dolgo geslo za `APP_BASIC_AUTH_PASS`.
4. Redeploy aplikacijo.

Lokalno lahko kopiraš `.env.example` v `.env` in vneseš svoje vrednosti.

## Nove funkcionalnosti (razširitev)

- Arhiv vozil (`status: active|archived`) in prikaz arhiviranih vozil.
- Kartica pregleda: kaj zapade v 30/60/90 dneh.
- Dnevnik dejanj (append-only pristop v pravilih).
- Upravljanje podatkov: izvoz CSV, predogled uvoza CSV in gumb za varnostno kopijo.
- Dokumenti po vozilih (Firebase Storage + Firestore metapodatki).
- Stanje sinhronizacije (`sync_status/global`).

## Firebase Functions / Scheduler

V mapi `functions/` je osnova za:

- `createAuditLog` (HTTP)
- `runBackupNow` (HTTP)
- `onBackupRequest` (trigger iz `backup_requests/*`)
- `sendDueRemindersEmail` (daily scheduler)

### Secrets (Functions)

Nastavi v Firebase Functions secrets:

- `EMAIL_PROVIDER` (trenutno podprt `resend`)
- `EMAIL_API_KEY`
- `EMAIL_FROM`
- `EMAIL_TO`

## Pravila in indeksi

Dodane datoteke:

- `firestore.rules`
- `storage.rules`
- `firestore.indexes.json`
- `firebase.json`

Po deployu jih uveljavi z Firebase CLI (`firebase deploy --only firestore:rules,firestore:indexes,storage,functions`).

V tej različici se evidenca shranjuje v **Firestore** (glej zgoraj). V izvorni lokalni različici aplikacije so podatki še v `localStorage`.

Vozila lahko **urediš** (obrazec zgoraj) ali **izbrišeš** (skupaj s plani in zapisi za to vozilo).

**Kilometri:** ob dodajanju/urejanju vozila nastaviš referenčne kilometre. *Trenutni kilometri* se nato samodejno nastavijo na največjo vrednost med tem vnosom in poljem *Kilometri* pri servisnih zapisih (ročnega vnosa na seznamu vozil ni).

## Vrste servisa

Privzete vrste (v spustnih seznamih):

- Mali servis  
- Veliki servis  
- Zamenjava baterije  
- Zamenjava manjših delov  
- Zamenjava večjih delov  

## Funkcionalnosti

- Podpora za več vozil  
- Načrte vzdrževanja uporabnik doda sam (razdelek *Načrti vzdrževanja*).  
- Status zapadlosti (`V REDU`, `KMALU`, `ZAPADLO`) glede na datum in kilometre  
- **Uredi / Izbriši** pri vsakem planu vzdrževanja (zapadlost)  
- **Uredi / Izbriši** pri vsakem servisnem zapisu  
- **Filtriranje prikaza** – pregled zapadlosti in zgodovine samo za izbrano vozilo (`Vsa vozila` = vse)  
- Zgodovina servisov s ceno (EUR), servisom in opombami  
- Posodobitev kilometrov  

## Opombe

- To je MVP in uporablja le lokalno shranjevanje.  
- Za produkcijo dodaj prijavo uporabnika, strežniško bazo (Supabase/Firebase) in obvestila.  
