# CLN-3 — Codespaces and proxies that rewrite Origin

The branch already contains `main`, so nothing needed fast-forwarding. CLN-2 is not merged yet, so its commits are on
this branch, but CLN-3 adds nothing to them.

**Both claims are confirmed in the code:**
- (a) Without `APP_ORIGIN`, `relyingParty()` (`backend/src/auth/webauthn.ts`) takes the origin and the rpId from the
  `Origin` header. Behind the Codespaces proxy that header is `https://localhost:4001`, so the rpId is `localhost`.
- (b) With `APP_ORIGIN` set, `sameOrigin()` (`backend/src/core/csrf.ts`) compares the raw `Origin` with it. A rewritten
  `Origin` is refused with 403 `CSRF_FAILED`, before any route runs, login included.

## Items

1. **Public origin helper.** `publicOrigin(config, req)` in `backend/src/core/origin.ts`, used by `relyingParty()`:
   - `APP_ORIGIN` set: return it, unchanged.
   - Otherwise, when Express trust proxy is on (`TRUST_PROXY`): use Express 5's own `req.protocol` and `req.host`, which
     read `X-Forwarded-Proto` and `X-Forwarded-Host` only from a trusted hop. The headers are not parsed by hand.
   - Otherwise: the `Origin` header, then `http://localhost:<port>`, as today.
   - CSRF is unchanged: without `APP_ORIGIN` the check is token-only, and production behaves exactly as today.
2. **Codespace.** The devcontainer sets `TRUST_PROXY=1` next to `APP_MODE=demo`.
   - Why `1`: exactly one proxy, the GitHub port forwarder, sits in front of the app, and the port is reachable only
     through it.
   - Why not `loopback`: it would depend on the address the forwarder connects from, which the evidence does not show.
   - Why not `true`: it would trust a whole chain.
   - Docs (README and every acceptance script that mentions Codespaces): do not set `APP_ORIGIN` there; make the port
     Public; open the URL from the Ports tab.
3. **Tests (both projects).** Simulated proxy: `Host: localhost:4000`, `X-Forwarded-Host: demo.example.test`,
   `X-Forwarded-Proto: https`, `Origin: https://localhost:4000`.
   - (i) Trust proxy on, demo, no `APP_ORIGIN`: rpId `demo.example.test`, stored challenge origin
     `https://demo.example.test`, and login passes.
   - (ii) Trust proxy off: the forwarded headers are ignored.
   - (iii) Production configuration: `APP_ORIGIN` wins, and a wrong `Origin` is still refused.
   - (iv) A full register-then-authenticate round trip with the existing `SoftAuthenticator`.
   - The new tests are shown to fail without the fix.
4. **Login with a leftover session cookie.**
   - **Checked in the code:** `authenticate` attaches any valid session cookie. The CSRF middleware then requires
     `x-csrf-token` for every unsafe request that has a session, so `POST /api/auth/login` with a stale but valid
     cookie and no token gets 403. A test will confirm this before the fix.
   - **Fix:**
     - The sign-in routes (the route-matrix scope `public`: login, passkey options and verify, recovery, cancel) skip
       the token check. They keep the `Origin` check whenever `APP_ORIGIN` is set, exactly as a login without a
       cookie is protected today. Login CSRF stays covered in production by `APP_ORIGIN`, which production requires.
     - A successful sign-in ends the session the request arrived with, so no orphan session remains.
5. **DEPLOYMENT.** A post-deploy check that the proxy passes `Origin` unchanged, with an exact echo command, and why.
6. **BACKLOG.** Mark CLN-3 done.

Questions: none.
