# 📱 WhatsApp Status Web Application

Enterprise Web Replica of the WhatsApp Status Desktop App.

## 🌟 4 Core Tabs
1. **✍️ New Post (Composer):** Drag-and-drop media upload, caption editor with route extraction, 23-account target selector grid with `READY` / `PHONE LIVE` / `LIVE` badges, dynamic skip counts, and schedule option.
2. **🔗 Sessions & QR:** View all 23 connected accounts, interactive QR scanner modal, phone pairing codes, restart/stop/delete lifecycle controls.
3. **📊 History & Queue:** Top metric cards (`TOTAL`, `PASSED`, `REVOKED`, `FAILED`, `QUEUE`), broadcast history list with 1-click status revocation.
4. **👁️ Live Statuses:** Real-time query of active WhatsApp stories, same-account duplicate highlighting using route fingerprinting, 1-click 'Remove Status' and 'Use in Composer'.

## 🚀 Running with Docker
```bash
docker compose up -d
```
Access at `http://localhost:3000`.
Connected to OpenWA API at `http://openwa-api:2785` (port 2785).
