import { createReadStream } from "node:fs";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { WorkerConfig } from "./config";

// Le bucket R2 « vynlmusic » par son interface S3. Il reste PRIVÉ : seul le Worker Cloudflare (cdn-worker/) le lit,
// sur présentation d'une adresse signée par l'API ; ce client-ci ne fait qu'y écrire et y supprimer.
export function createR2(config: WorkerConfig["r2"]) {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  return {
    async put(key: string, path: string, sizeBytes: number): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: sizeBytes,
          ContentType: "audio/mp4",
          // Le fichier d'une clé ne change jamais : le CDN et les navigateurs le gardent un an.
          CacheControl: "public, max-age=31536000, immutable",
        })
      );
    },
    async remove(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
