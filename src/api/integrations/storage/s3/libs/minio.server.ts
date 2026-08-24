import { ConfigService, S3 } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import * as MinIo from 'minio';
import { join } from 'path';
import { Readable, Transform } from 'stream';

const logger = new Logger('S3 Service');

const BUCKET = new ConfigService().get<S3>('S3');

interface Metadata extends MinIo.ItemBucketMetadata {
  'Content-Type': string;
}

const minioClient = (() => {
  if (BUCKET?.ENABLE) {
    return new MinIo.Client({
      endPoint: BUCKET.ENDPOINT,
      port: BUCKET.PORT,
      useSSL: BUCKET.USE_SSL,
      accessKey: BUCKET.ACCESS_KEY,
      secretKey: BUCKET.SECRET_KEY,
      region: BUCKET.REGION,
    });
  }
})();

const bucketName = BUCKET.BUCKET_NAME;

const bucketExists = async () => {
  if (minioClient) {
    try {
      const list = await minioClient.listBuckets();
      return list.find((bucket) => bucket.name === bucketName);
    } catch {
      return false;
    }
  }
};

const setBucketPolicy = async () => {
  if (minioClient) {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };
    await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
  }
};

const createBucket = async () => {
  if (minioClient) {
    try {
      const exists = await bucketExists();
      if (!exists) {
        await minioClient.makeBucket(bucketName);
      }
      if (!BUCKET.SKIP_POLICY) {
        await setBucketPolicy();
      }
      logger.info(`S3 Bucket ${bucketName} - ON`);
      return true;
    } catch (error) {
      logger.error('S3 ERROR:');
      logger.error(error);
      return false;
    }
  }
};

createBucket();

// --- upload retry ---------------------------------------------------------
//
// putObject used to be called once, with any failure logged and swallowed:
// uploadFile caught the error and *returned* it, and every caller ignored the
// return value. A transient blip therefore produced a Media row and a
// presigned URL for an object that was never stored — a record asserting media
// exists that resolves to 403 forever, with no retry and nothing to reconcile
// it later.
//
// Transient failures now get bounded retries with exponential backoff, and a
// final failure is reported to the caller instead of being lost.

const UPLOAD_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.S3_UPLOAD_MAX_ATTEMPTS || '4', 10));
const UPLOAD_BASE_DELAY_MS = Math.max(0, Number.parseInt(process.env.S3_UPLOAD_RETRY_DELAY_MS || '500', 10));

// Codes no retry can fix: wrong credentials, missing bucket, object too large,
// malformed request. Retrying these only delays the failure while holding the
// message-processing path open.
const PERMANENT_UPLOAD_ERRORS = new Set([
  'AccessDenied',
  'AccountProblem',
  'EntityTooLarge',
  'InvalidAccessKeyId',
  'InvalidArgument',
  'InvalidBucketName',
  'InvalidRequest',
  'MalformedXML',
  'MethodNotAllowed',
  'NoSuchBucket',
  'SignatureDoesNotMatch',
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
};

const putObjectWithRetry = async (
  objectName: string,
  file: Buffer | Transform | Readable,
  size: number,
  metadata: Metadata,
) => {
  let lastError: Error = new Error('upload never attempted');

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await minioClient.putObject(bucketName, objectName, file, size, metadata);
    } catch (error) {
      lastError = toError(error);
      const code = (error as { code?: string })?.code;

      // Only a Buffer survives a second attempt. A stream has already been
      // partially consumed by the failed try, so replaying it would store a
      // truncated object — worse than failing outright, because it would look
      // like a success.
      const replayable = Buffer.isBuffer(file);
      const permanent = PERMANENT_UPLOAD_ERRORS.has(code);
      const hasAttemptsLeft = attempt < UPLOAD_MAX_ATTEMPTS;

      if (permanent || !replayable || !hasAttemptsLeft) {
        const reason = permanent
          ? `non-retryable (${code})`
          : !replayable
            ? 'payload is a stream and cannot be replayed'
            : `exhausted ${UPLOAD_MAX_ATTEMPTS} attempts`;
        logger.error(`S3 upload FAILED for ${objectName} — ${reason}: ${lastError.message}`);
        throw lastError;
      }

      const delay = UPLOAD_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      logger.warn(
        `S3 upload attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS} failed for ${objectName} ` +
          `(${code || lastError.message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
};

const uploadFile = async (fileName: string, file: Buffer | Transform | Readable, size: number, metadata: Metadata) => {
  if (minioClient) {
    const objectName = join('evolution-api', fileName);
    try {
      metadata['custom-header-application'] = 'evolution-api';
      return await putObjectWithRetry(objectName, file, size, metadata);
    } catch (error) {
      // Resolves with the Error rather than throwing, deliberately. Not every
      // caller is inside a try/catch — sqs.controller.ts calls this bare, and a
      // throw there would propagate out of EventManager.emit(), which awaits
      // its integrations in sequence, silently skipping webhook/pusher/kafka
      // for that event. Callers that must not record a successful upload check
      // the returned value; see whatsapp.baileys.service.ts.
      return toError(error);
    }
  }
};

const getObjectUrl = async (fileName: string, expiry?: number) => {
  if (minioClient) {
    try {
      const objectName = join('evolution-api', fileName);
      if (expiry) {
        return await minioClient.presignedGetObject(bucketName, objectName, expiry);
      }
      return await minioClient.presignedGetObject(bucketName, objectName);
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }
};

const uploadTempFile = async (
  folder: string,
  fileName: string,
  file: Buffer | Transform | Readable,
  size: number,
  metadata: Metadata,
) => {
  if (minioClient) {
    const objectName = join(folder, fileName);
    try {
      metadata['custom-header-application'] = 'evolution-api';
      return await putObjectWithRetry(objectName, file, size, metadata);
    } catch (error) {
      return toError(error);
    }
  }
};

const deleteFile = async (folder: string, fileName: string) => {
  if (minioClient) {
    const objectName = join(folder, fileName);
    try {
      return await minioClient.removeObject(bucketName, objectName);
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

export { BUCKET, deleteFile, getObjectUrl, uploadFile, uploadTempFile };
