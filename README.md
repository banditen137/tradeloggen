# Tradeloggen

Stockrobbers köpsignaler och egna trades på ett ställe. En vanlig webbsida som kan sparas på hemskärmen som en app.

- **Signaler** är gemensamma för alla inloggade och skrivs in automatiskt av Claudes bevakare.
- **Trades** (Planerade, Aktiva, Stängda) är privata per person.

## Delar
| Fil | Vad |
|---|---|
| `index.html`, `styles.css`, `app.js` | Själva sidan |
| `config.js` | Supabase-adress och publik nyckel |
| `manifest.webmanifest`, `icons/` | Hemskärmsikon och app-läge |
| `supabase/schema.sql` | Tabeller och åtkomstregler |
| `supabase/seed.sql` | Signalerna som fanns i Claude-versionen |

## Driftsättning
1. Supabase: kör `schema.sql` och `seed.sql`. Stäng av öppen registrering. Skapa användare under Authentication → Users → Add user → Create new user med e-post `användarnamn@tradeloggen.app`, ett lösenord och "Auto Confirm User" ikryssat. Man loggar sedan in med bara användarnamnet.
2. Sätt Site URL och Redirect URL i Supabase (Authentication → URL Configuration) till appens adress.
3. Fyll i `config.js`.
4. Vercel: importera repot, inga byggsteg (Framework: Other). Lägg till domänen under Settings → Domains.
