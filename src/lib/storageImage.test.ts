import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artistImagePath,
  coverPath,
  extensionFromFilename,
  imageExtension,
  ownImagePath,
} from "./storageImage";

const ARTIST = "5b0c1d2e-3f40-4a51-8b62-73849a0b1c2d";
const PREFIX = `https://x.supabase.co/storage/v1/object/public/release-covers/${ARTIST}/`;

test("imageExtension n'accepte que JPEG, PNG et WebP", () => {
  assert.equal(imageExtension("image/jpeg"), "jpg");
  assert.equal(imageExtension("IMAGE/PNG"), "png");
  assert.equal(imageExtension("image/webp"), "webp");
  assert.equal(imageExtension("image/gif"), null);
  assert.equal(imageExtension("image/svg+xml"), null);
  assert.equal(imageExtension(undefined), null);
  assert.equal(imageExtension(42), null);
});

test("extensionFromFilename déduit le type des anciens clients, sans rien laisser passer d'autre", () => {
  assert.equal(extensionFromFilename("Photo.JPEG"), "jpg");
  assert.equal(extensionFromFilename("a.b.png"), "png");
  assert.equal(extensionFromFilename("x.webp"), "webp");
  assert.equal(extensionFromFilename("x.svg"), null);
  assert.equal(extensionFromFilename("x.jpg.exe"), null);
  assert.equal(extensionFromFilename("noext"), null);
  assert.equal(extensionFromFilename(undefined), null);
});

test("les chemins rangent le fichier sous le dossier de l'artiste", () => {
  assert.equal(coverPath("a", "b", "jpg", 123), "a/b-123.jpg");
  assert.equal(artistImagePath("a", "avatar", "png", 5), "a/avatar-5.png");
  assert.equal(artistImagePath("a", "banner", "webp", 6), "a/banner-6.webp");
});

test("ownImagePath accepte un fichier du dossier de l'artiste", () => {
  const file = `0a1b2c3d-1111-2222-3333-444455556666-1760000000000.jpg`;
  assert.equal(ownImagePath(`${PREFIX}${file}`, PREFIX, ARTIST), `${ARTIST}/${file}`);
  assert.equal(ownImagePath(`${PREFIX}x-1.webp`, PREFIX, ARTIST), `${ARTIST}/x-1.webp`);
  assert.equal(ownImagePath(`${PREFIX}avatar-1760000000000.png`, PREFIX, ARTIST), `${ARTIST}/avatar-1760000000000.png`);
});

test("ownImagePath refuse tout le reste", () => {
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
  for (const url of bad) assert.equal(ownImagePath(url, PREFIX, ARTIST), null, String(url));
});

test("ownImagePath exige un préfixe terminé par « / »", () => {
  const noSlash = PREFIX.slice(0, -1);
  assert.equal(ownImagePath(`${noSlash}x-1.jpg`, noSlash, ARTIST), null);
});

test("ownImagePath impose le début du nom quand on le demande", () => {
  assert.equal(ownImagePath(`${PREFIX}avatar-1.png`, PREFIX, ARTIST, "avatar-"), `${ARTIST}/avatar-1.png`);
  assert.equal(ownImagePath(`${PREFIX}banner-1.png`, PREFIX, ARTIST, "avatar-"), null);
  assert.equal(ownImagePath(`${PREFIX}x-1.png`, PREFIX, ARTIST, "avatar-"), null);
});
