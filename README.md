# Sober

A private, local-first recovery companion. Track your days, check in with yourself, write a journal, and notice your own patterns, one day at a time.

**Live site:** https://youlikome.github.io/sober/

> Sober is a self-tracking tool, not medical advice or a treatment service. If you are in crisis or feel unsafe, contact a local health service or your local emergency number.

## Features

- **Works with no account.** Everything is stored in your browser. No email or personal details are required.
- **Daily check-ins.** Mood, sleep quality, stress level, triggers and a free-text note.
- **Slip-up log.** Record a lapse without erasing your history. The app shows *consecutive days* and *total sober days* separately, and a slip-up only restarts the first.
- **Trends.** A 14-day chart of mood, sleep and stress, with plain-language insights about your own patterns.
- **Journal.** Private reflections with titles and dates.
- **Milestones and progress timeline.**
- **Data ownership.** Export everything as Markdown, CSV or JSON at any time.
- **Optional encrypted cloud backup.** Create an account to back up and restore across devices.
- **Light and dark themes**, responsive layout with phone navigation.

## Privacy and security

- By default, your data never leaves your device.
- If you create an account, your data is encrypted **in your browser** (AES-GCM, key derived from your passphrase with PBKDF2) before it is uploaded to Supabase. The server stores only encrypted text.
- Your encryption passphrase is never sent anywhere and **cannot be recovered**. If you forget it, the cloud backup cannot be decrypted. Keep a JSON export as a safeguard.
- Row-level security ensures each user can only read and write their own row.
- Your login session token is kept in browser storage on your device. Log out on shared computers.
- Syncing merges changes between devices. An entry deleted on one device may reappear after a merge from another.
- This is a starting implementation. Get an independent security review before relying on it for highly sensitive data in production.

## Run it locally

You need Python (or any static file server).

```bash
git clone https://github.com/youlikome/sober.git
cd sober
python -m http.server 5600
```

Open http://localhost:5600. The app must be served from `localhost` or HTTPS, because browser encryption is unavailable on plain `file://` pages.

## Set up cloud backup (optional)

1. Create a project at [supabase.com](https://supabase.com).
2. In **Project Settings → API**, copy the project URL and the `anon` public key into the top of `app.js`. Never put the `service_role` key in this repository.
3. In the **SQL Editor**, run:

```sql
create table if not exists public.sober_vault (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.sober_vault enable row level security;

create policy "Users can read their own vault"
on public.sober_vault for select to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own vault"
on public.sober_vault for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own vault"
on public.sober_vault for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

4. In **Authentication → URL Configuration**, set the **Site URL** and add **Redirect URLs** for every address you use, for example:
   - `http://localhost:5600`
   - `https://youlikome.github.io/sober/`

## Deploy

The site is static. On GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`. Every push to `main` redeploys.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | Page structure and dialogs |
| `styles.css` | Styling, themes and responsive layout |
| `app.js` | Core state, check-ins, journal, milestones, rendering |
| `extras.js` | Accounts, encrypted sync, slip-ups, trends, exports |

## License

MIT. See [LICENSE](LICENSE).
