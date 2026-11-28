# Energy Hub Shared Backend

This is the single API server used by both mobile apps and the Superadmin web UI.

| Module | API prefix |
|---|---|
| Energy Hub mobile app | `/api/v1` |
| Service Admin mobile app | `/api` |
| Website | `/api/website` |
| Existing Superadmin API | `/api/superadmin` |
| Superadmin web-console API | `/api/superadmin/console` |

## Setup

Copy `.env.example` to `.env`, set the PostgreSQL `DB_*` fields, `BASE_URL`, and a unique Superadmin password of at least 12 characters, then install dependencies. Use the same `BASE_URL` key locally and in production, changing only its value. `DATABASE_URL` is not used; all modules share the `DB_*` settings. Local development may use `DB_SSL=false`; production requires `DB_SSL=true` and verifies the database certificate. Set `DB_SSL_CA` to a trusted PEM certificate (use literal `\n` sequences for newlines) when the database uses a private CA; otherwise Node's system trust roots are used.

```powershell
Copy-Item .env.example .env
npm ci
```

Set `SUPERADMIN_EMAIL`, `SUPERADMIN_NAME`, and `SUPERADMIN_PASSWORD` before the first start. If migrating an existing JSON state file, set `SUPERADMIN_DATA_FILE` to its path relative to the backend folder; unset it after the first import. Superadmin console state is stored in the PostgreSQL `superadmin.console_state` table as one JSONB record; session and impersonation tables are created idempotently at startup. The legacy `/api/superadmin/auth/register` endpoint now requires an authenticated token with both the `superadmin` role and `superadmin` app claim. Public uploads use `UPLOADS_DIR` and `/uploads`; private customer attachments and Superadmin avatars use `PRIVATE_UPLOADS_DIR` and are served only through authenticated API routes. Live deployments must mount persistent storage at both configured directories.

Superadmin users can update their display name and phone number, manage a JPEG, PNG, or WebP profile photo, and change their password from their profile page. Photos are resized in the browser, limited to 512 KB, and stored under `PRIVATE_UPLOADS_DIR/superadmin-avatars`; sign-in email remains read-only because email verification is not configured. Password changes require the current password and a new password of 12–200 characters; the current session is retained and other active sessions are revoked.

Shared company details are stored in the Superadmin database state and can be edited only by accounts with `settings:edit`; they remain empty until configured. Access summaries identify whether page access comes from the user's role defaults or a custom assignment and link to each permitted console page.

Superadmin page visibility and API access use each signed-in account's effective `view` permission. Role defaults apply unless **User access** sets an account-specific matrix; this also allows an individual Superadmin account to be restricted without changing the full-access Superadmin role default. Accounts cannot change their own page access.

From **Users & Roles**, a signed-in Superadmin with user view/edit access can open an active non-Superadmin account directly in a separate tab without entering a password again. Normal sign-in still requires an email and password. The audit log records a standard reason for this access. The one-time launch secret is stored as a hash, expires after 60 seconds, and is bound to the active PostgreSQL-backed Superadmin session. The tab receives a 30-minute session scoped to that user and their effective permissions. The Superadmin's role and user-management access are rechecked on requests, sessions and launch secrets are revocable across backend instances, actions are audited with the initiating Superadmin, and password changes are blocked while viewing another account.

The Superadmin **App Registrations** page is available at `/directory`. It combines Energy Hub partner accounts with Service Admin user accounts, assigns stable unique registration IDs, and shows saved profile, service, payout, and rating information. Its API endpoint is `GET /api/superadmin/console/admin/registrations` and requires the `directory:view` permission. Existing access-control files are migrated to deny this personal-data view to viewer accounts by default.

Energy Hub partners can share foreground GPS while checked in to an active service job. The app requests location permission at check-in, sends updates only while the job workflow is open in the foreground, and stops tracking when the job is completed. Only the latest position is retained; Superadmin profile access shows a fresh position for two minutes and then hides its coordinates. No background tracking is performed. Service completion-time estimates and written customer reviews are not stored.

## Run

```powershell
npm run dev
```

The shared API listens on the `HOST` and `PORT` values in `.env` (the template uses port 3000). From `E:\gravityhub\superadmin\frontend`, run `npm ci` once and `npm start -- --host 127.0.0.1`; its `/api` proxy points to this server.

## Tests

```powershell
npm test
```

The suite includes Superadmin authentication, permissions, storage, and a shared-process integration test, along with the provider and service backend checks.
