# 📱 WhatsApp Status Cloud & Web Broadcast Hub

A modern, responsive, enterprise web replica of the WhatsApp Status Desktop application. Built to manage, broadcast, schedule, and monitor WhatsApp status updates across 20+ corporate and staff accounts simultaneously.

Deployable anywhere via Docker / Docker Compose — locally or in the cloud (AWS, GCP, DigitalOcean, Hetzner, etc.).

---

## 🌟 Architecture & Features

This web application connects directly to the OpenWA multi-session API gateway (`http://openwa-api:2785`) and faithfully replicates the 4 core workflows of the native macOS desktop app:

### 1. ✍️ New Post (Composer)
- **Media Upload & Drag-and-Drop:** Supports high-resolution images (`JPG`, `PNG`, `WEBP`, `GIF`) and videos (`MP4`, `MOV`) up to 100MB with instantaneous in-browser preview.
- **Smart Caption Editor:** Real-time character counter (0 / 700) with automatic campaign route detection.
- **Route Fingerprint Extractor:** Analyzes flight itineraries (e.g., `🛫 CHENNAI → AHMEDABAD · 🔥 FARES FROM ₹6,899`) and normalizes routes (`chennai->ahmedabad`) to prevent double-posting the same flyer.
- **23-Account Target Selector Grid:**
  - Individual checkboxes and instant `Select All` / `Deselect All` controls.
  - Live status badges: `READY` (🟢), `PHONE LIVE` (🟠), `LIVE` (🟠), and `OFFLINE` (🔴).
  - Dynamic button calculations: e.g. `🚀 Push to 21 New Accounts (2 live skipped)` or `🚫 Already Live on Selected Accounts`.
- **Scheduled Publishing:** Toggle between `⚡ Send Now` and `⏰ Schedule for Later` with date-time picker. Background scheduler executes due broadcasts automatically every 10 seconds.
- **Live Broadcast Progress Modal:** Real-time session-by-session delivery feedback with retry tracking and status IDs.

### 2. 🔗 Sessions & QR (Account Lifecycle)
- **Multi-Account Overview:** Grid view of all 23 connected WhatsApp accounts showing push names, phone numbers, connection status, engine status (Baileys), and last active timestamps.
- **Interactive QR Scanner Modal:** Real-time QR polling with live visual rendering and auto-close upon successful authentication.
- **Phone Pairing Code Option:** Request and display 8-character pairing codes (`ABCD-1234`) for direct phone linking without a camera.
- **Lifecycle Management:** 1-click controls to Start, Stop, Restart, Logout, or Delete individual sessions.
- **Batch Actions:** `➕ New Session`, `🔄 Reconnect Non-Ready`, `▶️ Start All`, and `⏹️ Stop All`.

### 3. 📊 History & Queue
- **Executive Metric Cards:**
  - 📦 **TOTAL:** Complete count of broadcast records.
  - ✅ **PASSED:** Statuses successfully posted to accounts.
  - ↩️ **REVOKED:** Statuses that were taken down from WhatsApp.
  - ❌ **FAILED:** Unsuccessful broadcast attempts with error logs.
  - ⏰ **QUEUE:** Pending scheduled broadcasts with live countdown timers.
- **Per-Account Delivery Breakdown:** Expandable logs showing the specific status ID and outcome for each individual WhatsApp account.
- **1-Click WhatsApp Revoke / Undo:** Directly issues `DELETE /api/sessions/:id/status/:statusId` to all accounts that published the flyer, deleting it off WhatsApp.
- **Filters & Search:** Quick filter pills (`All`, `Passed`, `Scheduled`, `Revoked`, `Failed`) and keyword search.

### 4. 👁️ Live Statuses (Real-Time Monitor)
- **Live WhatsApp Stories Query:** Polls active stories across all connected accounts.
- **Origin Detection:** Distinguishes between stories posted via `📱 Phone` (staff mobile phone) vs `🖥️ Desktop` (API broadcast).
- **Same-Account Duplicate Highlighting:** Flags accounts where the same flyer or route was posted multiple times (`⚠️ DUPLICATE: Posted 2x on this account!`).
- **1-Click Story Removal:** Delete live stories directly from WhatsApp with one click.
- **Use in Composer:** Instantly copy existing story captions and media back into the Composer tab for re-use or re-broadcasting.

---

## 🚀 Quick Start with Docker

### Prerequisites
- Docker Engine 20.10+
- Docker Compose v2+

### 1. Launch the Stack
Run the following command in the repository root:

```bash
docker compose up -d
```

This will launch:
1. **`openwa-api`**: OpenWA Baileys WhatsApp Gateway on port `2785`.
2. **`whatsapp-status-web`**: The Web Application Hub on port `3000`.

### 2. Open the Web App
Open your browser and navigate to:
```
http://localhost:3000
```

---

## ⚙️ Configuration & Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Web app server listening port | `3000` |
| `OPENWA_BASE_URL` | OpenWA gateway URL inside Docker | `http://openwa-api:2785` |
| `OPENWA_API_KEY` | Master authentication API key | `trust-me-bro-this-is-ultra-secure-key` |
| `DATA_DIR` | Directory for history persistence | `/app/data` |
| `UPLOADS_DIR` | Directory for uploaded media | `/app/uploads` |

---

## 📁 Repository Structure

```
.
├── docker-compose.yml          # Docker Compose stack definition
├── patches/                    # OpenWA Baileys engine status patches
│   ├── baileys-status.js
│   ├── Client.js
│   └── messages-send.js
├── scripts/                    # Windows launcher & OpenWA auto-patcher scripts
│   ├── start-openwa-dashboard.bat
│   └── update-and-patch-openwa.bat
├── web-app/
│   ├── Dockerfile              # Lightweight Node.js 20 Alpine container
│   ├── package.json
│   ├── server.js               # Express API proxy, scheduler, and history store
│   ├── .dockerignore
│   ├── data/
│   │   └── history.json        # Persistent broadcast history
│   ├── uploads/                # Temporary uploaded media files
│   └── public/
│       ├── index.html          # Responsive 4-tab Single Page Application
│       ├── app.css             # WhatsApp dark-mode modern design system
│       └── app.js              # State management, duplicate engine, and UI logic
└── README.md
```

---

## ☁️ Cloud Deployment (VPS / Cloud Instances)

To deploy to AWS EC2, DigitalOcean, GCP Compute Engine, or any Linux server:

1. Clone this repository:
   ```bash
   git clone https://github.com/itsbalaji-io/Whatsapp_Status_Dashboard.git
   cd Whatsapp_Status_Dashboard
   ```
2. Start the services:
   ```bash
   docker compose up -d --build
   ```
3. Access via `http://<your-server-ip>:3000` (or configure a reverse proxy such as Nginx / Caddy with HTTPS on port 443).

---

## 🔒 Security
- All internal communication between the web application and the OpenWA API gateway uses the secured Docker bridge network `automation-network`.
- Requests require the `x-api-key` header matching `API_MASTER_KEY`.
- Non-root privileged container specifications with tight security capabilities (`no-new-privileges: true`, cap drops).
