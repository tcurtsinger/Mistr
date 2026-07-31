import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "fixtures");
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
const shouldDownload = process.argv.includes("--download");

if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.fixtures) ||
  manifest.fixtures.length === 0
) {
  throw new Error("Unsupported or invalid fixture manifest");
}

const fixtureIds = new Set();
for (const fixture of manifest.fixtures) {
  validateFixture(fixture, fixtureIds);
  const destination = resolve(fixtureRoot, fixture.localPath);
  const allowedRoot = resolve(fixtureRoot, "cache") + sep;
  if (!destination.startsWith(allowedRoot)) {
    throw new Error(`${fixture.id}: localPath escapes fixtures/cache`);
  }

  if (shouldDownload) {
    await downloadIfNeeded(fixture, destination);
  }

  await verifyFixture(fixture, destination);
}

console.log(`Verified ${manifest.fixtures.length} fixture(s).`);

function validateFixture(fixture, knownIds) {
  if (
    typeof fixture?.id !== "string" ||
    !/^[a-z0-9-]+$/.test(fixture.id) ||
    knownIds.has(fixture.id)
  ) {
    throw new Error("Fixture IDs must be unique lowercase slugs");
  }
  knownIds.add(fixture.id);

  if (
    typeof fixture.source !== "string" ||
    !fixture.source.trim() ||
    fixture.bucket !== "unidata-nexrad-level2" ||
    typeof fixture.key !== "string" ||
    !fixture.key ||
    typeof fixture.station !== "string" ||
    !/^K[A-Z0-9]{3}$/.test(fixture.station) ||
    typeof fixture.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      fixture.observedAt,
    ) ||
    !Number.isFinite(Date.parse(fixture.observedAt)) ||
    !Number.isSafeInteger(fixture.sizeBytes) ||
    fixture.sizeBytes < 1 ||
    typeof fixture.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(fixture.sha256) ||
    typeof fixture.etag !== "string" ||
    !/^[a-f0-9]{32}(?:-\d+)?$/.test(fixture.etag) ||
    typeof fixture.localPath !== "string"
  ) {
    throw new Error(`${fixture.id}: invalid fixture metadata`);
  }

  const url = new URL(fixture.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "unidata-nexrad-level2.s3.amazonaws.com" ||
    url.pathname.slice(1) !== fixture.key
  ) {
    throw new Error(`${fixture.id}: source URL does not match its fixed bucket key`);
  }
}

async function downloadIfNeeded(fixture, destination) {
  try {
    await stat(destination);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });

  const url = new URL(fixture.url);
  if (url.protocol !== "https:" || url.hostname !== "unidata-nexrad-level2.s3.amazonaws.com") {
    throw new Error(`${fixture.id}: download host is not allowed`);
  }

  console.log(`Downloading ${fixture.id} (${fixture.sizeBytes} bytes)...`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) {
    throw new Error(`${fixture.id}: download failed with HTTP ${response.status}`);
  }

  try {
    await pipeline(response.body, createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function verifyFixture(fixture, destination) {
  const details = await stat(destination).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`${fixture.id}: missing; run npm run fixture:download`);
    }
    throw error;
  });

  if (details.size !== fixture.sizeBytes) {
    throw new Error(`${fixture.id}: expected ${fixture.sizeBytes} bytes, found ${details.size}`);
  }

  const digest = createHash("sha256");
  await pipeline(createReadStream(destination), digest);
  const actualHash = digest.digest("hex");
  if (actualHash !== fixture.sha256) {
    throw new Error(`${fixture.id}: SHA-256 mismatch (${actualHash})`);
  }
}
