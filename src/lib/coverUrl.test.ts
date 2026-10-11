import { test } from "node:test";
import assert from "node:assert/strict";
import { coverExtension, coverPath, ownCoverPath } from "./coverUrl";

const ARTIST = "5b0c1d2e-3f40-4a51-8b62-73849a0b1c2d";
const PREFIX = `https://x.supabase.co/storage/v1/object/public/release-covers/${ARTIST}/`;

test("coverExtension n'accepte que JPEG, PNG et WebP", () => {
  assert.equal(coverExtension("image/jpeg"), "jpg");
  assert.equal(coverExtension("IMAGE/PNG"), "png");
  assert.equal(coverExtension("image/webp"), "webp");
  assert.equal(coverExtension("image/gif"), null);
  assert.equal(coverExtension("image/svg+xml"), null);
  assert.equal(coverExtension(undefined), null);
  assert.equal(coverExtension(42), null);
});

test("coverPath range le fichier sous le dossier de l'artiste", () => {
  assert.equal(coverPath("a", "b", "jpg", 123), "a/b-123.jpg");
});

test("ownCoverPath accepte un fichier du dossier de l'artiste", () => {
  const file = `0a1b2c3d-1111-2222-3333-444455556666-1760000000000.jpg`;
  assert.equal(ownCoverPath(`${PREFIX}${file}`, PREFIX, ARTIST), `${ARTIST}/${file}`);
  assert.equal(ownCoverPath(`${PREFIX}x-1.webp`, PREFIX, ARTIST), `${ARTIST}/x-1.webp`);
});

test("ownCoverPath refuse tout le reste", () => {
  const bad: unknown[] = [
    null,
    undefined,
    42,
    "",
    "https://evil.example/cover.jpg",
    // dossier d'un autre artiste
    "https://x.supabase.co/storage/v1/object/public/release-covers/other/x-1.jpg",
    // autre bucket
    `https://x.supabase.co/storage/v1/object/public/artist-images/${ARTIST}/x-1.jpg`,
    // sortie du dossier, sous-dossier, paramètres, mauvaise extension
    `${PREFIX}../other/x-1.jpg`,
    `${PREFIX}sub/x-1.jpg`,
    `${PREFIX}x-1.jpg?track=1`,
    `${PREFIX}x-1.jpg#frag`,
    `${PREFIX}x-1.svg`,
    `${PREFIX}x-1.jpg.exe`,
    `${PREFIX}`,
  ];
  for (const url of bad) assert.equal(ownCoverPath(url, PREFIX, ARTIST), null, String(url));
});

test("ownCoverPath exige un préfixe terminé par « / »", () => {
  const noSlash = PREFIX.slice(0, -1);
  assert.equal(ownCoverPath(`${noSlash}x-1.jpg`, noSlash, ARTIST), null);
});
