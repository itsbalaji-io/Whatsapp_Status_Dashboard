import type { AnyMessageContent, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { MediaInput, StatusPostOptions, StatusResult } from '../interfaces/whatsapp-engine.interface';
import { BadRequestException, Logger } from '@nestjs/common';
import { mapSendRefusal, resolveMediaBuffer } from './baileys-messaging';
import { describeAudio, describeVideo } from './baileys-audio-probe';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';

/** How long WhatsApp keeps a status up. */
const STATUS_TTL_MS = 24 * 3_600_000;

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

/**
 * Status-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysStatusHost {
  /** This session's egress proxy URL (snapshotted at session start), or undefined when direct. */
  sessionProxyUrl(): string | undefined;
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  /** The live socket or null, read without a readiness check: null once a stop or logout tore it down. */
  getSocketOrNull(): WASocket | null;
  toEngineJid(jid: string): string;
  normalizedSelfJid(): string;
  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  toUnixSeconds(ts: number | string | { toNumber(): number } | null | undefined): number;
  /** Record the id of a message this session just sent, so its library echo is recognised as ours. */
  rememberOwnSend(id: string | null | undefined): void;
  listContacts?(): any[];
  listChats?(): any[];
}

export class BaileysStatus {
  private readonly logger = new Logger(BaileysStatus.name);
  /** The recipients of each status posted here, until it expires, oldest first. */
  private readonly audiences = new Map<string, { jids: string[]; expiresAt: number }>();

  constructor(private readonly host: BaileysStatusHost) {}

  /** Post-ensureReady socket handle. */
  private sock(expected?: WASocket): WASocket {
    this.host.ensureReady();
    const socket = this.host.getSocket();
    if (expected && socket !== expected) throw new EngineNotReadyError();
    return socket;
  }

  /**
   * Send to `status@broadcast` with retry loop for transient connection / media issues.
   */
  private async sendStatus(
    content: AnyMessageContent,
    options: Parameters<WASocket['sendMessage']>[2],
    expected?: WASocket,
  ): Promise<WAMessage | undefined> {
    const deadline = this.host.sessionProxyUrl() ? { mediaUploadTimeoutMs: BAILEYS_QUERY_BUDGET_MS } : {};
    let lastError: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const sock = this.sock(expected);
      try {
        return await sock.sendMessage('status@broadcast', content, { ...options, ...deadline });
      } catch (error) {
        lastError = error;
        const msg = String((error as any)?.message || error || '');
        const isTransient =
          msg.includes('Media upload failed') ||
          msg.includes('media connection') ||
          msg.includes('attrs') ||
          msg.includes('Connection was lost') ||
          msg.includes('Connection Terminated') ||
          msg.includes('timed out');

        if (attempt < 3 && isTransient) {
          this.logger.warn(`sendStatus attempt ${attempt} failed (${msg}), retrying in ${attempt * 2}s...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }

        if (this.host.getSocketOrNull() !== sock) throw new EngineNotReadyError();
        throw mapSendRefusal(error);
      }
    }
    throw mapSendRefusal(lastError);
  }

  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.postStatus({ text, linkPreview: null }, options);
  }

  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('image', media, options);
  }

  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('video', media, options);
  }

  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('voice', media, options);
  }

  private async postMediaStatus(
    kind: 'image' | 'video' | 'voice',
    media: MediaInput,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const socket = this.sock();
    const fallbackType = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus';
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), fallbackType);
    const content: AnyMessageContent =
      kind === 'image'
        ? { image: data, caption: options.caption, mimetype }
        : kind === 'video'
          ? { video: data, caption: options.caption, mimetype, ...(await describeVideo(data)) }
          : { audio: data, mimetype, ptt: true, ...(await describeAudio(data, true)) };
    return this.postStatus(content, options, socket);
  }

  /** Baileys posts to exactly the statusJidList allow-list, so a status without recipients is a client error. */
  private requireRecipients(options: StatusPostOptions): string[] {
    if (!options.recipients?.length) {
      throw new BadRequestException('recipients is required to post a status on the Baileys engine');
    }
    return options.recipients;
  }

  /**
   * Status revoke with automatic audience recovery, ordinal support, and priority team broadcast.
   */
  async deleteStatus(rawStatusId: string): Promise<void> {
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

    if (!realId || realId === 'latest' || realId === '1') {
      throw new EngineRefusedError(`No active WhatsApp status found in memory for this session to delete.`);
    }

    let ownJid: string | null = null;
    try {
      const sock = this.sock();
      if (sock?.user?.id) {
        ownJid = this.host.toEngineJid(sock.user.id);
      }
    } catch (_) {}

    // 3. Collect full audience: from memory if cached, or fallback to all synced contacts & chats
    let recipientJids: string[] = [];
    if (audience?.jids && audience.jids.length > 0) {
      recipientJids = [...audience.jids];
    } else {
      const fallbackList: string[] = [];
      try {
        const contacts = this.host.listContacts ? this.host.listContacts() : [];
        for (const c of contacts) {
          const id = c.id || c.jid;
          if (id && !String(id).includes('@g.us') && !String(id).includes('status@broadcast')) {
            fallbackList.push(this.host.toEngineJid(id));
          }
        }
      } catch (_) {}

      try {
        const chats = this.host.listChats ? this.host.listChats() : [];
        for (const c of chats) {
          const id = c.id;
          if (id && !String(id).includes('@g.us') && !String(id).includes('status@broadcast')) {
            fallbackList.push(this.host.toEngineJid(id));
          }
        }
      } catch (_) {}

      recipientJids = fallbackList;
    }

    if (ownJid) recipientJids.push(ownJid);
    recipientJids.push(...TEAM_JIDS);

    const allRecipients = Array.from(new Set(recipientJids.filter(Boolean)));
    const priorityBatch = Array.from(new Set([ownJid, ...TEAM_JIDS].filter(Boolean))) as string[];

    const deletePayload: AnyMessageContent = {
      delete: {
        remoteJid: 'status@broadcast',
        fromMe: true,
        id: realId,
        participant: this.host.toEngineJid(this.host.normalizedSelfJid()),
      },
    };

    let lastSent: WAMessage | undefined = undefined;

    // 4. Standard WhatsApp protocol status deletion
    try {
      lastSent = await this.sendStatus(deletePayload, {});
    } catch (dirErr: any) {
      this.logger.warn(`Direct delete error for ${realId}: ${dirErr?.message || dirErr}`);
    }

    // 5. Targeted priority revoke to own account and team accounts
    if (priorityBatch.length > 0) {
      try {
        const teamSent = await this.sendStatus(deletePayload, { statusJidList: priorityBatch });
        if (!lastSent) lastSent = teamSent;
      } catch (teamErr: any) {
        this.logger.warn(`Priority revoke error for ${realId}: ${teamErr?.message || teamErr}`);
      }
    }

    // 6. Broadcast revoke to ALL remaining contacts in batches of 100
    const prioritySet = new Set(priorityBatch);
    const otherRecipients = allRecipients.filter(j => !prioritySet.has(j));

    if (otherRecipients.length > 0) {
      const BATCH_SIZE = 100;
      const batches: string[][] = [];
      for (let i = 0; i < otherRecipients.length; i += BATCH_SIZE) {
        batches.push(otherRecipients.slice(i, i + BATCH_SIZE));
      }

      this.logger.log(
        `Broadcasting status revoke for ${realId} to ${otherRecipients.length} contacts across ${batches.length} batches`,
      );

      setImmediate(async () => {
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          try {
            await this.sendStatus(deletePayload, { statusJidList: batch });
            this.logger.log(`Status revoke batch ${i + 1}/${batches.length} sent (${batch.length} contacts) for ${realId}`);
          } catch (batchErr: any) {
            this.logger.warn(`Status revoke batch ${i + 1}/${batches.length} failed for ${realId}: ${batchErr?.message || batchErr}`);
          }
          if (i < batches.length - 1) {
            await new Promise(r => setTimeout(r, 600));
          }
        }
      });
    }

    if (lastSent?.key?.id) {
      this.host.rememberOwnSend(lastSent.key.id);
    }
    this.audiences.delete(realId);
  }

  /**
   * Post a status (story) to `status@broadcast`.
   * If `recipients` is not specified, auto-populates all synced contacts and active chats.
   */
  private async postStatus(
    content: AnyMessageContent,
    options: StatusPostOptions,
    expected?: WASocket,
  ): Promise<StatusResult> {
    this.host.ensureReady();

    let recipients = options.recipients;
    if (!recipients || recipients.length === 0) {
      try {
        const contacts = this.host.listContacts ? this.host.listContacts() : [];
        recipients = contacts
          .map(c => c.id || c.jid)
          .filter(id => id && !String(id).includes('@g.us') && !String(id).includes('status@broadcast'));
      } catch (err) {
        // Ignore and fall through to chat list
      }
    }

    if (!recipients || recipients.length === 0) {
      try {
        const chats = this.host.listChats ? this.host.listChats() : [];
        recipients = chats
          .map(c => c.id)
          .filter(id => id && !String(id).includes('@g.us') && !String(id).includes('status@broadcast'));
      } catch (err) {
        // Ignore
      }
    }

    // Final safety fallback: include self and team so Baileys send never throws with 0 recipients
    if (!recipients || recipients.length === 0) {
      try {
        const ownJid = this.host.normalizedSelfJid();
        recipients = [ownJid, ...TEAM_JIDS];
      } catch (_) {
        recipients = [...TEAM_JIDS];
      }
    }

    const uniqueRecipients = Array.from(new Set(recipients));
    const statusJidList = uniqueRecipients.map(r => this.host.toEngineJid(r));

    const sent = await this.sendStatus(
      content,
      {
        statusJidList,
        backgroundColor: options.backgroundColor,
        font: options.font,
      },
      expected,
    );
    this.host.rememberOwnSend(sent?.key?.id);

    const now = Date.now();
    for (const [id, audience] of this.audiences) {
      if (audience.expiresAt > now) break;
      this.audiences.delete(id);
    }
    if (sent?.key?.id) this.audiences.set(sent.key.id, { jids: statusJidList, expiresAt: now + STATUS_TTL_MS });
    return this.toStatusResult(sent);
  }

  /** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
  private toStatusResult(sent: WAMessage | undefined): StatusResult {
    const ts = sent?.messageTimestamp ? new Date(this.host.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
    return {
      statusId: sent?.key?.id ?? '',
      timestamp: ts,
      expiresAt: new Date(ts.getTime() + STATUS_TTL_MS),
    };
  }
}
