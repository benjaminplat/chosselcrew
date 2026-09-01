# GEGL Chosselcrew 🎲

**Geen Eerste, Geen Laatste** — het Bankzitters-spel voor het weekendje weg. 10 rondes, 8 spelers, live scorebord.

## Hoe het werkt

- De 8 deelnemers staan vast in de code (`PLAYERS`, zowel in `worker.js` als `index.html` — houd ze gelijk).
- Vóór de onthulling ziet iedereen alleen de mysterieuze teaser: naam invullen en stemmen op "wie wordt eerste?" en "wie wordt laatste?". De quoteringen bewegen live mee met de stemmen; een stem kan gewijzigd worden (zelfde naam overschrijft).
- De spelleider bepaalt zélf het moment van onthulling met de knop in het Admin-tabblad — de countdown op de teaser is puur sfeer. Vergrendelen kan ook weer.
- Na elke ronde vult de spelleider in het Admin-tabblad de volledige uitslag (1 t/m 8) in.
- Het tabblad Quotering toont beide stemmarkten live, ook tijdens het weekend.
- Strafpunten: **nummer 1 → 2 pt, nummer 2 → 1 pt, nummer 7 → 1 pt, nummer 8 → 2 pt.** Posities 3-6 zijn veilig.
- Het scorebord ververst elke 5 seconden op alle telefoons. Minste punten = chosselkoning 👑, de drie met de meeste punten staan in de gevarenzone 💀 en krijgen een straf.
- Zonder gekoppelde backend draait de app in **demo-modus** (banner in beeld) zodat je alles lokaal kunt uitproberen.

### Teaser / geheimhouding

Tot de onthulling ziet iedereen alleen de mysterieuze landingspagina met countdown en de stemming. Scorebord, rondes en quoteringen blijven verborgen. De spelleider komt altijd binnen via de subtiele "spelleider"-link onderaan de teaser + de admin-code (die je als Worker-secret hebt gezet — bijvoorbeeld je eigen pincode) en onthult de app voor iedereen met één knop in Admin; binnen een paar seconden klappen alle telefoons om. De countdown-datum (`REVEAL_AT` bovenin `index.html`) is alleen sfeer.

### Gimmicks

- **Straf-quoteringen**: elke speler heeft een live quotering op de eindstraf (TOTO-stijl), berekend uit de tussenstand — hoe lager het getal, hoe waarschijnlijker een straf. Naarmate er meer rondes gespeeld zijn, weegt de stand zwaarder mee.
- **Scorebord-animaties**: bij een nieuwe uitslag schuiven de rijen vloeiend naar hun nieuwe plek, met ▲/▼-indicatoren die tonen wie er is gestegen of gezakt.
- **Rondetimer**: de spelleider start vanuit Admin een countdown (0:30 / 1:00 / 2:00) voor de gekozen ronde. Die telt live af op álle telefoons, kleurt rood onder de 10 seconden en verdwijnt vanzelf; een uitslag invoeren stopt de timer van die ronde.

## Architectuur

```
GitHub Pages (index.html)  ──fetch──►  Cloudflare Worker  ──►  Cloudflare KV ("state")
```

Eén statische pagina, één Worker, één KV-key. De admin-code staat **alleen** als secret in de Worker — nooit in de code of de repo.

## Deployen

### 1. Cloudflare Worker + KV

Vereist: een (gratis) Cloudflare-account en `wrangler` (`npm install -g wrangler`, daarna `wrangler login`).

```bash
cd worker

# KV-namespace aanmaken; kopieer de id uit de output
wrangler kv namespace create GEGL_KV

# Plak de id in wrangler.toml bij [[kv_namespaces]]

# Admin-code instellen (verzin zelf iets; dit is wat jij straks intikt in de app)
wrangler secret put ADMIN_CODE

# Deployen
wrangler deploy
```

Na `wrangler deploy` krijg je een URL zoals `https://gegl-chosselcrew-api.<jouwnaam>.workers.dev` — die heb je nodig in stap 2.

### 2. Frontend koppelen

Open `index.html` en vul bovenin het script je Worker-URL in:

```js
const API_BASE = "https://gegl-chosselcrew-api.<jouwnaam>.workers.dev";
```

### 3. GitHub Pages

```bash
git init && git add index.html README.md worker/ test/
git commit -m "GEGL Chosselcrew"
git branch -M main
git remote add origin https://github.com/benjaminplat/GEGL.git
git push -u origin main
```

Zet daarna in de repo **Settings → Pages → Deploy from branch → main / root** aan. Na een minuutje staat de app op `https://benjaminplat.github.io/GEGL/`. Deel die link in de groepsapp. 📲

### 4. Testen vóór het weekend

1. Open de link, registreer een paar testnamen (mag ook vanaf één telefoon in verschillende browsers/incognito).
2. Ga naar Admin, vul je admin-code in, en voer een test-uitslag in.
3. Check dat het scorebord op een tweede toestel vanzelf bijwerkt.
4. Reset alles via **Admin → Gevarenzone → Alles resetten** en je bent klaar voor het echte werk.

## API (Worker)

| Methode | Pad | Auth | Doet |
|---|---|---|---|
| GET | `/state` | – | Spelers, ronde-uitslagen, timer, reveal-status en stem-aggregaten |
| POST | `/vote` | – | `{ voter, first, last }` — stem uitbrengen of wijzigen |
| POST | `/round` | `X-Admin-Code` | `{ round, ranking: [ids 1→8] }` |
| POST | `/timer` | `X-Admin-Code` | `{ round, seconds }` — countdown starten, `seconds: 0` stopt |
| POST | `/reveal` | `X-Admin-Code` | `{ revealed: true\|false }` — app ont-/vergrendelen |
| POST | `/reset` | `X-Admin-Code` | Wist stemmen, rondes en timer; vergrendelt weer |

## Goed om te weten

- KV is "eventually consistent": een update kan op een ander toestel een paar seconden later zichtbaar zijn. Voor 8 spelers en één spelleider is dat geen probleem.
- Een ronde opnieuw invoeren mag gewoon: de nieuwe uitslag overschrijft de oude; een stem opnieuw uitbrengen ook.
- Individuele stemkeuzes verlaten de server nooit — alleen totalen per speler en de namen van wie gestemd heeft.
- De admin-code staat uitsluitend als Worker-secret (`wrangler secret put ADMIN_CODE`), nooit in de code.
