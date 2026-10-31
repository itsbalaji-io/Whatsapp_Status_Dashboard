"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysStatus = void 0;
const common_1 = require("@nestjs/common");
const baileys_messaging_1 = require("./baileys-messaging");
const baileys_audio_probe_1 = require("./baileys-audio-probe");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const STATUS_TTL_MS = 24 * 3_600_000;
class BaileysStatus {
    host;
    audiences = new Map();
    constructor(host) {
        this.host = host;
    }
    sock() {
        return this.host.getSocket();
    }
    async sendStatus(content, options) {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const sock = this.sock();
            try {
                return await sock.sendMessage('status@broadcast', content, options);
            }
            catch (error) {
                lastError = error;
                const msg = String(error?.message || error || '');
                const isTransient = msg.includes('Media upload failed') ||
                                    msg.includes('media connection') ||
                                    msg.includes('attrs') ||
                                    msg.includes('Connection was lost') ||
                                    msg.includes('Connection Terminated') ||
                                    msg.includes('timed out');
                if (attempt < 3 && isTransient) {
                    console.warn(`[BaileysStatus] sendStatus attempt ${attempt} failed (${msg}), retrying in ${attempt * 2}s...`);
                    await new Promise(r => setTimeout(r, attempt * 2000));
                    continue;
                }
                if (this.host.getSocketOrNull() !== sock)
                    throw new engine_not_ready_error_1.EngineNotReadyError();
                throw error;
            }
        }
        throw lastError;
    }
    postTextStatus(text, options) {
        return this.postStatus({ text, linkPreview: null }, options);
    }
    postImageStatus(media, options) {
        return this.postMediaStatus('image', media, options);
    }
    postVideoStatus(media, options) {
        return this.postMediaStatus('video', media, options);
    }
    postVoiceStatus(media, options) {
        return this.postMediaStatus('voice', media, options);
    }
    async postMediaStatus(kind, media, options) {
        this.host.ensureReady();
        const fallbackType = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus';
        const { data, mimetype } = await (0, baileys_messaging_1.resolveMediaBuffer)(media, this.host.sessionProxyUrl(), fallbackType);
        const content = kind === 'image'
            ? { image: data, caption: options.caption, mimetype }
            : kind === 'video'
                ? { video: data, caption: options.caption, mimetype }
                : { audio: data, mimetype, ptt: true, ...(await (0, baileys_audio_probe_1.describeAudio)(data, true)) };
        return this.postStatus(content, options);
    }
    async deleteStatus(rawStatusId) {
        this.host.ensureReady();
        const target = String(rawStatusId || '').trim();
        const lower = target.toLowerCase();

        let realId = target;
        let audience = this.audiences.get(realId);

        // 0. If "all" is requested
        if (lower === 'all') {
            const keys = Array.from(this.audiences.keys());
            for (const key of keys) {
                try {
                    await this.deleteStatus(key);
                } catch (_) {}
            }
            return;
        }

        // 1. If keyword / ordinal requested (e.g. "latest", "last", "1", "oldest")
        if (lower === 'latest' || lower === 'last' || lower === 'newest') {
            const keys = Array.from(this.audiences.keys());
            if (keys.length > 0) {
                realId = keys[keys.length - 1];
                audience = this.audiences.get(realId);
            }
        } else if (lower === '1' || lower === 'oldest' || lower === 'first') {
            const keys = Array.from(this.audiences.keys());
            if (keys.length > 0) {
                realId = keys[0];
                audience = this.audiences.get(realId);
            }
        } else if (/^\d+$/.test(lower)) {
            const idx = parseInt(lower, 10) - 1;
            const keys = Array.from(this.audiences.keys());
            if (idx >= 0 && idx < keys.length) {
                realId = keys[idx];
                audience = this.audiences.get(realId);
            }
        }

        // 2. If ID contains underscores (e.g. true_status@broadcast_3EB0270EC28352521BB5A3_...)
        if (!audience && realId.includes('_')) {
            const parts = realId.split('_');
            const candidate = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
            if (this.audiences.has(candidate)) {
                realId = candidate;
                audience = this.audiences.get(realId);
            } else {
                realId = candidate;
            }
        }

        // 3. Fallback for audience JID list if not cached in memory
        let jids = audience?.jids;
        if (!jids || jids.length === 0) {
            try {
                const contacts = this.host.listContacts ? this.host.listContacts() : [];
                jids = contacts
                    .map(c => this.host.toEngineJid(c.id || c.jid))
                    .filter(Boolean);
            } catch (_) {}
        }

        if (!realId || realId === 'latest' || realId === '1') {
            throw new engine_refused_error_1.EngineRefusedError(`No active WhatsApp status found in memory for this session to delete.`);
        }

        const TEAM_JIDS = [
            '917639438633@s.whatsapp.net', // hari-mice
            '919962238633@s.whatsapp.net', // ticketing-raju
            '918939538633@s.whatsapp.net', // ticketing-bala
            '917550238633@s.whatsapp.net', // holidays-raja
            '919176838633@s.whatsapp.net', // holidays-akash
            '917200438633@s.whatsapp.net', // ticketing-hardik
            '919150038633@s.whatsapp.net', // holidays-aanand
            '918428938633@s.whatsapp.net', // holidays-varsha
            '918940538633@s.whatsapp.net', // holidays-kajal
            '917639738633@s.whatsapp.net', // holidays-deepika
            '919159138633@s.whatsapp.net', // holidays-dura
            '917200538633@s.whatsapp.net', // ticketing-suresh
            '917868038633@s.whatsapp.net', // ticketing-raji
            '919962138633@s.whatsapp.net', // ticketing-mukhtar
            '918148738633@s.whatsapp.net', // ticketing-sundar
            '917200938633@s.whatsapp.net', // visa-iyyapan
            '919514338633@s.whatsapp.net', // monica-visa
            '917871738633@s.whatsapp.net', // nithya-visa
            '919514138633@s.whatsapp.net', // maran-visa
            '919361878953@s.whatsapp.net', // accounts-2
            '919884738633@s.whatsapp.net', // holidays
            '916382113034@s.whatsapp.net', // hr-raghu
        ];

        let ownJid = null;
        try {
            const sock = this.sock();
            if (sock?.user?.id) {
                ownJid = this.host.toEngineJid(sock.user.id);
            }
        } catch (_) {}

        const priorityBatch = Array.from(new Set([ownJid, ...TEAM_JIDS].filter(Boolean)));

        let lastSent = null;
        // 1. Standard WhatsApp protocol status deletion
        try {
            lastSent = await this.sendStatus({
                delete: {
                    remoteJid: 'status@broadcast',
                    fromMe: true,
                    id: realId,
                },
            });
        } catch (dirErr) {
            console.warn(`[BaileysStatus] Direct delete error for ${realId}:`, dirErr?.message || dirErr);
        }

        // 2. Targeted revoke to connected team accounts
        if (priorityBatch.length > 0) {
            try {
                const teamSent = await this.sendStatus({
                    delete: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: realId,
                    },
                }, { statusJidList: priorityBatch });
                if (!lastSent) lastSent = teamSent;
            } catch (teamErr) {
                console.warn(`[BaileysStatus] Team revoke error for ${realId}:`, teamErr?.message || teamErr);
            }
        }

        // 3. Background non-blocking notification to original audience if cached
        if (audience?.jids && audience.jids.length > 0) {
            const extraJids = audience.jids.slice(0, 100);
            setImmediate(() => {
                this.sendStatus({
                    delete: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: realId,
                    },
                }, { statusJidList: extraJids }).catch(() => {});
            });
        }

        if (lastSent?.key?.id) {
            this.host.rememberOwnSend(lastSent.key.id);
        }
        this.audiences.delete(realId);
    }
    async postStatus(content, options) {
        this.host.ensureReady();
        let recipients = options.recipients;
        if (!recipients?.length) {
            try {
                const contacts = this.host.listContacts ? this.host.listContacts() : [];
                recipients = contacts
                    .map(c => c.id || c.jid)
                    .filter(id => id && !String(id).includes('@g.us') && !String(id).includes('status@broadcast'));
            } catch (err) {
                // Ignore and fall through to validation
            }
        }
        if (!recipients?.length) {
            throw new common_1.BadRequestException('recipients is required to post a status on the Baileys engine (no synced contacts found)');
        }
        const statusJidList = recipients.map(r => this.host.toEngineJid(r));
        const sent = await this.sendStatus(content, {
            statusJidList,
            backgroundColor: options.backgroundColor,
            font: options.font,
        });
        this.host.rememberOwnSend(sent?.key?.id);
        const now = Date.now();
        for (const [id, audience] of this.audiences) {
            if (audience.expiresAt > now)
                break;
            this.audiences.delete(id);
        }
        if (sent?.key?.id)
            this.audiences.set(sent.key.id, { jids: statusJidList, expiresAt: now + STATUS_TTL_MS });
        return this.toStatusResult(sent);
    }
    toStatusResult(sent) {
        const ts = sent?.messageTimestamp ? new Date(this.host.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
        return {
            statusId: sent?.key?.id ?? '',
            timestamp: ts,
            expiresAt: new Date(ts.getTime() + STATUS_TTL_MS),
        };
    }
}
exports.BaileysStatus = BaileysStatus;
//# sourceMappingURL=baileys-status.js.map