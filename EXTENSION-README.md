# AceBackend Account Extensions (separate integration project)

This project extends the supplied AceBackend without changing the main frontend. It adds profile editing, password reset/login, in-app notifications, notification read state, a capability-discovery endpoint, migrations, and GitHub Actions/GitLab CI pipelines.

## Added endpoints
- `PATCH /api/users/me` (JWT): update display name, date of birth, notification preferences.
- `POST /api/auth/password/reset/request`: request OTP through existing auth service.
- `POST /api/auth/password/reset/confirm`: verify OTP and set a password hash.
- `POST /api/auth/password/login`: password login for users who have set a password.
- `GET /api/notifications?unreadOnly=false&limit=50` (JWT).
- `PATCH /api/notifications/:id/read` (JWT, ownership checked).
- `POST /api/notifications/read-all` (JWT).
- `GET /api/capabilities`: discover enabled and deliberately disabled capabilities.

## Local setup
1. Install Node.js 22 and PostgreSQL 16.
2. Copy `.env.example` to `.env`; set `DATABASE_URL` and a strong `JWT_SECRET` (32+ chars).
3. `npm install`
4. `npx prisma generate`
5. `npx prisma migrate deploy`
6. `npm run typecheck && npm test && npm run build`
7. `npm run dev`

## CI/CD
- GitHub Actions: `.github/workflows/ci.yml` runs on push and pull request; uses a PostgreSQL service, typecheck, unit tests, migrations, and build.
- GitLab CI: `.gitlab-ci.yml` does the equivalent.
- These pipelines validate builds and migrations. They do not deploy automatically; configure protected Render deploy hooks only after the pipeline passes and secrets are stored in the CI secret store.

## Production requirements
- Configure a real email/SMS delivery provider. The current base OTP service only logs codes when development OTP is explicitly enabled. Never enable development OTP in production.
- Password reset reuses the OTP service; ensure identifier normalization, delivery provider, rate limits, monitoring, and abuse controls are reviewed before public release.
- Existing user records have no password hash until users complete reset/set-password.
- Use HTTPS, strict CORS origins, database backups, secret rotation, and migration review.
- Financial deposits/payouts, bonus issuance, and agent commissions remain disabled by design. The supplied backend lacks provider settlement, compliance/eligibility rules, audited privileged admin workflows, and fraud controls; do not fake success or directly mutate wallet balances. Implement only after those controls and applicable legal review exist.
