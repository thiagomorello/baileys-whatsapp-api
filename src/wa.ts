import type { Boom } from '@hapi/boom';
import { initStore, Store, useSession } from '@thiagomorello/baileys-store';
import type { ConnectionState, proto, SocketConfig, WASocket } from '@whiskeysockets/baileys';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import type { Response } from 'express';
// import { writeFile } from 'fs/promises';
// import { join } from 'path';
import { toDataURL } from 'qrcode';
import type { WebSocket } from 'ws';
import { logger, prisma } from './shared';
import { delay, openai } from './utils';

type Session = WASocket & {
  destroy: () => Promise<void>;
  store: Store;
};

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
const SSEQRGenerations = new Map<string, number>();

const RECONNECT_INTERVAL = Number(process.env.RECONNECT_INTERVAL || 0);
const MAX_RECONNECT_RETRIES = Number(process.env.MAX_RECONNECT_RETRIES || 5);
const SSE_MAX_QR_GENERATION = Number(process.env.SSE_MAX_QR_GENERATION || 5);
const SESSION_CONFIG_ID = 'session-config';

export async function init() {
  initStore({ prisma, logger });
  const sessions = await prisma.session.findMany({
    select: { sessionId: true, data: true },
    where: { id: { startsWith: SESSION_CONFIG_ID } },
  });

  for (const { sessionId, data } of sessions) {
    const { readIncomingMessages, ...socketConfig } = JSON.parse(data);
    createSession({ sessionId, readIncomingMessages, socketConfig });
  }
}

function shouldReconnect(sessionId: string) {
  let attempts = retries.get(sessionId) ?? 0;

  if (attempts < MAX_RECONNECT_RETRIES) {
    attempts += 1;
    retries.set(sessionId, attempts);
    return true;
  }
  return false;
}

type createSessionOptions = {
  sessionId: string;
  res?: Response;
  SSE?: boolean;
  readIncomingMessages?: boolean;
  socketConfig?: SocketConfig;
};

export async function createSession(options: createSessionOptions) {
  const { sessionId, res, SSE = false, readIncomingMessages = false, socketConfig } = options;
  const configID = `${SESSION_CONFIG_ID}-${sessionId}`;
  let connectionState: Partial<ConnectionState> = { connection: 'close' };

  const destroy = async (logout = true) => {
    try {
      await Promise.all([
        logout && socket.logout(),
        prisma.chat.deleteMany({ where: { sessionId } }),
        prisma.contact.deleteMany({ where: { sessionId } }),
        prisma.message.deleteMany({ where: { sessionId } }),
        prisma.groupMetadata.deleteMany({ where: { sessionId } }),
        prisma.session.deleteMany({ where: { sessionId } }),
      ]);
    } catch (e) {
      logger.error(e, 'An error occured during session destroy');
    } finally {
      sessions.delete(sessionId);
    }
  };

  const handleConnectionClose = () => {
    const code = (connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;
    const restartRequired = code === DisconnectReason.restartRequired;
    const doNotReconnect = !shouldReconnect(sessionId);

    if (code === DisconnectReason.loggedOut || doNotReconnect) {
      if (res) {
        !SSE && !res.headersSent && res.status(500).json({ error: 'Unable to create session' });
        res.end();
      }
      destroy(doNotReconnect);
      return;
    }

    if (!restartRequired) {
      logger.info({ attempts: retries.get(sessionId) ?? 1, sessionId }, 'Reconnecting...');
    }
    setTimeout(() => createSession(options), restartRequired ? 0 : RECONNECT_INTERVAL);
  };

  const handleNormalConnectionUpdate = async () => {
    if (connectionState.qr?.length) {
      if (res && !res.headersSent) {
        try {
          const qr = await toDataURL(connectionState.qr);
          res.status(200).json({ qr });
          return;
        } catch (e) {
          logger.error(e, 'An error occured during QR generation');
          res.status(500).json({ error: 'Unable to generate QR' });
        }
      }
      destroy();
    }
  };

  const handleSSEConnectionUpdate = async () => {
    let qr: string | undefined = undefined;
    if (connectionState.qr?.length) {
      try {
        qr = await toDataURL(connectionState.qr);
      } catch (e) {
        logger.error(e, 'An error occured during QR generation');
      }
    }

    const currentGenerations = SSEQRGenerations.get(sessionId) ?? 0;
    if (!res || res.writableEnded || (qr && currentGenerations >= SSE_MAX_QR_GENERATION)) {
      res && !res.writableEnded && res.end();
      destroy();
      return;
    }

    const data = { ...connectionState, qr };
    if (qr) SSEQRGenerations.set(sessionId, currentGenerations + 1);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let isSending = false; 

  const handleConnectionUpdate = SSE ? handleSSEConnectionUpdate : handleNormalConnectionUpdate;
  const { state, saveCreds } = await useSession(sessionId);
  const socket = makeWASocket({
    printQRInTerminal: true,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    ...socketConfig,
    auth: {
      creds: state.creds,

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      keys: makeCacheableSignalKeyStore(
        //@ts-ignore
        state.keys,
        logger
      ),
    },
    logger,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    getMessage: async (key) => {
      const data = await prisma.message.findFirst({
        where: { remoteJid: key.remoteJid!, id: key.id!, sessionId },
      });
      return (data?.message || undefined) as proto.IMessage | undefined;
    },
  });

  const store = new Store(sessionId, socket.ev);
  sessions.set(sessionId, { ...socket, destroy, store });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', (update) => {
    console.log(update);
    connectionState = update;
    const { connection } = update;

    if (connection === 'open') {
      retries.delete(sessionId);
      SSEQRGenerations.delete(sessionId);
    }
    if (connection === 'close') handleConnectionClose();
    handleConnectionUpdate();
  });

  socket.ev.on('messages.upsert', async (m) => {
    console.log('chegou mensagem')
    const message = m.messages[0];
    console.log(message?.key?.remoteJid)
    console.log(message?.message)
    //if (message?.key?.remoteJid === '120363256828117187@g.us') {
      const jid = message.key.remoteJid ? message.key.remoteJid : '';

      const textMessage =
        message?.message?.extendedTextMessage?.text || message?.message?.conversation;
        if(textMessage?.trim() === '!resumo' && isSending === true){
          await socket.presenceSubscribe(jid).catch(() => {
            console.log('Erro ao setar presença');
          });
          await socket.sendPresenceUpdate('composing', jid).catch(() => {
            console.log('Erro ao atualizar presença');
          });
          await socket.sendMessage(jid, { text: 'Demora um poquinho, ok?' }, {});
        }
      if (textMessage?.trim() === '!resumo' && !isSending) {

        
        isSending = true;
        await socket.presenceSubscribe(jid).catch(() => {
          console.log('Erro ao setar presença');
        });
        await socket.sendPresenceUpdate('composing', jid).catch(() => {
          console.log('Erro ao atualizar presença');
        });
        await socket.sendMessage(jid, { text: 'Gerando resumo... Demora um poquinho, ok?' }, {});
        const randomDelay = Math.floor(Math.random() * 10000) + 1000;
        await delay(randomDelay);
        await socket.sendPresenceUpdate('paused', jid).catch(() => {
          console.log('Erro ao atualizar presença para pausado');
        });
        const messages = await prisma.message.findMany({
          take: Number(100),
          where: { sessionId, remoteJid: jid },
          orderBy: { messageTimestamp: 'asc' },
        });

        const resumo = messages
          .map((m: any) => {
            if(m?.message?.imageMessage?.url){
              return m?.message?.imageMessage?.caption ? `${m.pushName || m.remoteJid} enviou uma imagem com a legenda: ${m?.message?.imageMessage?.caption}`.trim() : `${m.pushName || m.remoteJid} enviou uma imagem`.trim();
            }
            else if (m?.message?.audioMessage?.url) {
              return `${m.pushName || m.remoteJid} enviou um áudio`.trim();
            }
            else if (m?.message?.extendedTextMessage?.text || m?.message?.conversation) {
              return `${m.pushName || m.remoteJid} disse: ${
                m?.message?.extendedTextMessage?.text || m?.message?.conversation
              }`.trim();
            }
            else if(m?.message?.reactionMessage?.text !== undefined){
              return `${m.pushName || m.remoteJid} reagiu com ${m?.message?.reactionMessage?.text}`.trim();
            }
            return false;
          })
          .filter(Boolean)
          .join('\n');
        console.log(resumo);

        const chatCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: 'user',
              content: `Faça um resumo do dialogo abaixo, utilizando formatação para WhatsApp\n\n Diálogo:${resumo}`,
            },
          ],
          model: 'gpt-4-turbo',
        }).catch(() => {
          return {
            choices: [
              {
                message: {
                  content: 'Não foi possível gerar um resumo por um erro de comunicação com o chat gpt',
                },
              },
            ],
          };
        });

        const messageText = `${chatCompletion.choices[0].message.content}`
          chatCompletion.choices[0].message.content || 'Não foi possível gerar um resumo';

        await socket.sendMessage(jid, { text: messageText }, {});
        isSending = false; 
      }
    //}

    if (message.key.fromMe || m.type !== 'notify') return;

    //await delay(1000);
    //await socket.readMessages([message.key]);
  });

  // Debug events
  // socket.ev.on('messaging-history.set', (data) => dump('messaging-history.set', data));
  // socket.ev.on('chats.upsert', (data) => dump('chats.upsert', data));
  // socket.ev.on('contacts.update', (data) => dump('contacts.update', data));
  // socket.ev.on('groups.upsert', (data) => dump('groups.upsert', data));

  await prisma.session.upsert({
    create: {
      id: configID,
      sessionId,
      data: JSON.stringify({ readIncomingMessages, ...socketConfig }),
    },
    update: {},
    where: { sessionId_id: { id: configID, sessionId } },
  });
}

export function getSessionStatus(session: Session) {
  const state = ['CONNECTING', 'CONNECTED', 'DISCONNECTING', 'DISCONNECTED'];
  let status = state[(session.ws as WebSocket).readyState];
  status = session.user ? 'AUTHENTICATED' : status;
  return status;
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, session]) => ({
    id,
    status: getSessionStatus(session),
  }));
}

export function getSession(sessionId: string) {
  return sessions.get(sessionId);
}

export async function deleteSession(sessionId: string) {
  sessions.get(sessionId)?.destroy();
}

export function sessionExists(sessionId: string) {
  return sessions.has(sessionId);
}

export async function jidExists(
  session: Session,
  jid: string,
  type: 'group' | 'number' = 'number'
) {
  try {
    if (type === 'number') {
      const [result] = await session.onWhatsApp(jid);
      return !!result?.exists;
    }

    const groupMeta = await session.groupMetadata(jid);
    return !!groupMeta.id;
  } catch (e) {
    return Promise.reject(e);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// export async function dump(fileName: string, data: any) {
//   const path = join(__dirname, '..', 'debug', `${fileName}.json`);
//   await writeFile(path, JSON.stringify(data, null, 2));
// }
