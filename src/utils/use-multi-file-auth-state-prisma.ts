import { prismaRepository } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { CacheConf, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR } from '@config/path.config';
import { AuthenticationState, BufferJSON, initAuthCreds, WAProto as proto } from 'baileys';
import fs from 'fs/promises';
import path from 'path';

const fixFileName = (file: string): string | undefined => {
  if (!file) {
    return undefined;
  }
  const replacedSlash = file.replace(/\//g, '__');
  const replacedColon = replacedSlash.replace(/:/g, '-');
  return replacedColon;
};

/**
 * Whether a session row exists.
 *
 * Throws on a read failure instead of reporting "no session". The two are not
 * the same thing and treating them as one destroys live sessions: the caller
 * answers "no session" by generating fresh credentials and writing them over
 * the row it just failed to read.
 */
export async function keyExists(sessionId: string): Promise<boolean> {
  const key = await prismaRepository.session.findUnique({ where: { sessionId: sessionId } });
  return !!key;
}

export async function saveKey(sessionId: string, keyJson: any): Promise<any> {
  const exists = await keyExists(sessionId);
  try {
    if (!exists)
      return await prismaRepository.session.create({
        data: {
          sessionId: sessionId,
          creds: JSON.stringify(keyJson),
        },
      });
    await prismaRepository.session.update({
      where: { sessionId: sessionId },
      data: { creds: JSON.stringify(keyJson) },
    });
  } catch {
    return null;
  }
}

/**
 * The stored credentials, or null ONLY when no session row exists.
 *
 * A database error propagates. Swallowing it here is what cost two live
 * WhatsApp sessions on 2026-08-25: the box was deep into swap, a read did not
 * come back in time, this returned null, and the bootstrap below overwrote
 * both working sessions with freshly generated, unpaired credentials — with
 * no log line, because the error had already been discarded.
 */
export async function getAuthKey(sessionId: string): Promise<any> {
  const register = await keyExists(sessionId);
  if (!register) return null;
  const auth = await prismaRepository.session.findUnique({ where: { sessionId: sessionId } });
  if (!auth?.creds) return null;
  return JSON.parse(auth.creds);
}

async function deleteAuthKey(sessionId: string): Promise<any> {
  try {
    const register = await keyExists(sessionId);
    if (!register) return;
    await prismaRepository.session.delete({ where: { sessionId: sessionId } });
  } catch {
    return;
  }
}

async function fileExists(file: string): Promise<any> {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return true;
  } catch {
    return;
  }
}

const logger = new Logger('useMultiFileAuthStatePrisma');

export default async function useMultiFileAuthStatePrisma(
  sessionId: string,
  cache: CacheService,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
}> {
  const localFolder = path.join(INSTANCE_DIR, sessionId);
  const localFile = (key: string) => path.join(localFolder, fixFileName(key) + '.json');
  await fs.mkdir(localFolder, { recursive: true });

  async function writeData(data: any, key: string): Promise<any> {
    const dataString = JSON.stringify(data, BufferJSON.replacer);
    const cacheConfig = configService.get<CacheConf>('CACHE');

    if (key != 'creds') {
      if (cacheConfig.REDIS.ENABLED) {
        return await cache.hSet(sessionId, key, data);
      } else {
        await fs.writeFile(localFile(key), dataString);
        return;
      }
    }
    await saveKey(sessionId, dataString);
    return;
  }

  async function readData(key: string): Promise<any> {
    try {
      let rawData;
      const cacheConfig = configService.get<CacheConf>('CACHE');

      if (key != 'creds') {
        if (cacheConfig.REDIS.ENABLED) {
          return await cache.hGet(sessionId, key);
        } else {
          if (!(await fileExists(localFile(key)))) return null;
          rawData = await fs.readFile(localFile(key), { encoding: 'utf-8' });
          return JSON.parse(rawData, BufferJSON.reviver);
        }
      } else {
        rawData = await getAuthKey(sessionId);
      }

      if (rawData === null || rawData === undefined) return null;
      const parsedData = JSON.parse(rawData, BufferJSON.reviver);
      return parsedData;
    } catch (error) {
      // Signal keys may legitimately be missing and null is the right answer
      // for them. Credentials are different: null here is read as "this
      // instance was never paired", and the caller acts on that by replacing
      // the stored session. A failed read must therefore propagate.
      if (key === 'creds') throw error;
      return null;
    }
  }

  async function removeData(key: string): Promise<any> {
    try {
      const cacheConfig = configService.get<CacheConf>('CACHE');

      if (key != 'creds') {
        if (cacheConfig.REDIS.ENABLED) {
          return await cache.hDelete(sessionId, key);
        } else {
          await fs.unlink(localFile(key));
        }
      } else {
        await deleteAuthKey(sessionId);
      }
    } catch {
      return;
    }
  }

  async function removeCreds(): Promise<any> {
    const cacheConfig = configService.get<CacheConf>('CACHE');

    // Redis
    try {
      if (cacheConfig.REDIS.ENABLED) {
        await cache.delete(sessionId);
        logger.info({ action: 'redis.delete', sessionId });

        return;
      }
    } catch (err) {
      logger.warn({ action: 'redis.delete', sessionId, err });
    }

    logger.info({ action: 'auth.key.delete', sessionId });

    await deleteAuthKey(sessionId);
  }

  // Only ever generate a new identity when the store confirms there is none.
  // If reading fails we let the error out: the caller reconnects on its own,
  // and a session that could not be read is left exactly as it was rather
  // than being replaced by an unpaired one.
  let creds;
  try {
    creds = await readData('creds');
  } catch (error) {
    logger.error({
      action: 'auth.creds.read.failed',
      sessionId,
      warn: 'Refusing to re-initialise credentials — the existing session is left untouched.',
      error,
    });
    throw error;
  }
  if (!creds) {
    logger.info({ action: 'auth.creds.init', sessionId, note: 'no stored session — pairing from scratch' });
    creds = initAuthCreds();
    await writeData(creds, 'creds');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.create(value);
              }

              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;

              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => {
      return writeData(creds, 'creds');
    },

    removeCreds,
  };
}
