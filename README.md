# NOC Command Center

Professional multi-VPS / WordPress / WooCommerce control HUD.

## Architecture

Netlify hosts the UI only.

```
Browser / Netlify HUD
        |
        | HTTPS
        v
Private Control Worker
        |
        +-- SSH VPS-01
        +-- SSH VPS-02
        +-- SSH VPS-03
              |
              +-- WP-CLI
              +-- systemctl
              +-- Docker
              +-- filesystem
              +-- package manager
```

Never expose SSH passwords, private keys, or Anthropic API keys in frontend JavaScript.

## Current UI

- server matrix
- CPU / RAM / disk / inode telemetry
- domain inventory
- WordPress / WooCommerce estate
- security posture
- bulk plugin operations
- product / stock / order controls
- WPVivid backup cleanup control
- PayPal/user controls
- Claude operator terminal
- responsive terminal/NOC aesthetic

## Netlify

```bash
npm install
npm run build
```

Publish directory: `dist`.

## Required worker API

Configure `VITE_CONTROL_API_URL` in Netlify.

Expected endpoints:

```
POST /v1/connect/test
GET  /v1/servers
GET  /v1/servers/:id/telemetry
GET  /v1/servers/:id/domains
POST /v1/jobs
GET  /v1/jobs/:id
POST /v1/claude/plan
```

Destructive operations must use preview -> confirmation -> execute -> verify -> audit log.
