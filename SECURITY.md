# Nestham Security Model

This document catalogues known attack vectors against the Nestham platform, current mitigations, and recommended future improvements.

---

## 1. Relay / Bridge Attack (Matchmaking Abuse)

**Description**
An attacker opens multiple WebSocket connections from different IPs (or via proxies) to monopolise the matchmaking queue, either to ensure they are always paired with a target user or to deny service to legitimate users.

**Risk level:** High

**Current mitigation in Nestham**
- Maximum 2 active WebSocket connections per IP address. A third connection attempt is rejected with an error message and the socket is closed immediately.
- If two `join` messages arrive from the same IP within 10 seconds, both sockets are disconnected and the event is logged.

**Recommended future mitigation**
- Require a lightweight proof-of-work or CAPTCHA token before allowing a join, making scripted mass-connection expensive.
- Maintain a per-IP cooldown (e.g. 30 s) between queue re-entries after a disconnect.
- Use a distributed rate-limit store (Redis) if the server is scaled horizontally.

---

## 2. IP Leakage via ICE Candidates

**Description**
WebRTC ICE candidate exchange can reveal a user's real IP address to their peer, even when the user believes they are anonymous. A peer can log these candidates to de-anonymise users or to enable targeted attacks.

**Risk level:** High

**Current mitigation in Nestham**
- ICE candidates are relayed through the signaling server; the server itself does not expose IPs in the signaled data.
- The client only uses public Google STUN servers, which do not share candidate data with third parties.

**Recommended future mitigation**
- Deploy a TURN server and force `relay` ICE transport policy so that peer IPs are never exposed to each other: `{ iceTransportPolicy: 'relay' }`.
- Use an ephemeral TURN credential system (time-limited tokens) to prevent credential sharing.
- Consider a privacy-preserving STUN proxy if relay-only mode is not feasible.

---

## 3. TURN Server Abuse

**Description**
If a TURN server is added in the future, authenticated credentials could be extracted from the client JavaScript and reused to relay arbitrary traffic through the TURN server (a bandwidth/cost attack).

**Risk level:** Medium

**Current mitigation in Nestham**
- No TURN server is currently configured, so this vector does not apply today.

**Recommended future mitigation**
- Issue short-lived TURN credentials (e.g. 1-hour TTL) generated server-side per session using the TURN REST API or a shared secret (RFC 8489 §9.2).
- Never embed long-lived static TURN credentials in client-side JavaScript.
- Set TURN server bandwidth quotas per credential to limit blast radius.

---

## 4. Signaling MITM (Man-in-the-Middle)

**Description**
If the signaling WebSocket connection is not encrypted, a network attacker (coffee-shop Wi-Fi, ISP, etc.) could intercept or tamper with offer/answer/ICE messages, potentially injecting a rogue peer into the session.

**Risk level:** High (on plain HTTP), Low (on HTTPS/WSS)

**Current mitigation in Nestham**
- The client automatically selects `wss://` when the page is served over HTTPS, ensuring the signaling channel is TLS-encrypted.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) are set on all HTTP responses to reduce browser-level attack surface.

**Recommended future mitigation**
- Enforce HTTPS at the infrastructure level (e.g. via a reverse proxy or load balancer) and add an HSTS header (`Strict-Transport-Security: max-age=31536000`).
- Add a Content-Security-Policy header to prevent XSS-based credential theft.
- Consider WebRTC DTLS certificate pinning for high-assurance deployments.

---

## 5. Browser Extension Microphone Access

**Description**
A malicious browser extension installed by the user could silently capture the microphone stream independently of Nestham, recording conversations without the platform's knowledge.

**Risk level:** Medium

**Current mitigation in Nestham**
- Nestham operates entirely within the browser security sandbox; it cannot directly prevent extensions from accessing the mic.
- The Terms of Service explicitly prohibit recording conversations.

**Recommended future mitigation**
- This is fundamentally a client-side trust boundary; no server-side mitigation is fully effective.
- Document the risk clearly in the privacy notice and encourage users to audit installed extensions.
- Consider displaying a warning if the page detects unusual audio track states (e.g. `MediaStreamTrack.muted` toggling unexpectedly), though this is a heuristic only.

---

## 6. Endpoint Compromise (Server Takeover)

**Description**
If the signaling server host is compromised, an attacker gains access to in-flight signaling messages, IP connection logs, and the ability to manipulate matchmaking arbitrarily.

**Risk level:** High

**Current mitigation in Nestham**
- IP addresses in logs are masked to the first two octets (e.g. `192.168.x.x`), limiting the value of log exfiltration for de-anonymising users.
- The server holds no persistent user data — sessions are entirely in-memory and are cleared on disconnect.

**Recommended future mitigation**
- Run the server process as a non-root OS user with minimal filesystem permissions.
- Use a process supervisor (systemd, PM2) with automatic restarts and resource limits.
- Enable OS-level auditing (auditd) and ship logs to an immutable external log store.
- Regularly apply OS and Node.js security patches; pin the Node.js version in a `.nvmrc` or Docker image.
- Consider deploying behind a Web Application Firewall (WAF) to block known exploit patterns before they reach the application.

---

## Reporting Security Issues

Please report vulnerabilities responsibly to **nestham.help@gmail.com** with the subject line `[SECURITY]`. We aim to acknowledge reports within 72 hours.
