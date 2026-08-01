import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  parseFixtureVerificationArgs,
  selectFixturesForVerification,
} from "./fixture-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "fixtures");
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
const { shouldDownload, setName } = parseFixtureVerificationArgs(process.argv.slice(2));

if (
  manifest.schemaVersion !== 2 ||
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

}

validateFixtureSets(manifest.fixtureSets, fixtureIds);
const selectedFixtures = selectFixturesForVerification(
  manifest.fixtures,
  manifest.fixtureSets,
  setName,
);
for (const fixture of selectedFixtures) {
  const destination = resolve(fixtureRoot, fixture.localPath);
  if (shouldDownload) await downloadIfNeeded(fixture, destination);
  await verifyFixture(fixture, destination);
}

console.log(
  `Verified ${selectedFixtures.length} fixture(s)${setName ? ` from ${setName}` : ""}.`,
);

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
    ![
      "level2_archive",
      "level3_n0s",
      "iem_ridge_png",
      "iem_ridge_world_file",
    ].includes(fixture.datasetKind) ||
    typeof fixture.station !== "string" ||
    !/^[A-Z0-9]{4}$/.test(fixture.station) ||
    typeof fixture.observedAt !== "string" ||
    !isValidUtcTimestamp(fixture.observedAt) ||
    !Number.isSafeInteger(fixture.sizeBytes) ||
    fixture.sizeBytes < 1 ||
    typeof fixture.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(fixture.sha256) ||
    (fixture.etag !== undefined && (
      typeof fixture.etag !== "string" ||
      !/^[a-f0-9]{32}(?:-\d+)?$/.test(fixture.etag)
    )) ||
    typeof fixture.localPath !== "string"
  ) {
    throw new Error(`${fixture.id}: invalid fixture metadata`);
  }

  validateSourceIdentity(fixture);
}

function validateSourceIdentity(fixture) {
  const url = new URL(fixture.url);
  if (url.protocol !== "https:") {
    throw new Error(`${fixture.id}: fixture URL must use HTTPS`);
  }

  if (fixture.datasetKind === "level2_archive") {
    if (
      fixture.bucket !== "unidata-nexrad-level2" ||
      url.hostname !== "unidata-nexrad-level2.s3.amazonaws.com" ||
      url.pathname.slice(1) !== fixture.key
    ) {
      throw new Error(`${fixture.id}: source URL does not match its fixed Level II key`);
    }
    const match = /^(\d{4})\/(\d{2})\/(\d{2})\/(K[A-Z0-9]{3})\/\4\1\2\3_(\d{2})(\d{2})(\d{2})_V\d{2}(?:\.gz)?$/.exec(fixture.key);
    if (!match) throw new Error(`${fixture.id}: unsupported Level II archive key format`);
    const [, year, month, day, station, hour, minute, second] = match;
    assertKeyIdentity(fixture, station, `${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    return;
  }

  if (fixture.datasetKind === "level3_n0s") {
    if (
      fixture.bucket !== "unidata-nexrad-level3" ||
      url.hostname !== "unidata-nexrad-level3.s3.amazonaws.com" ||
      url.pathname.slice(1) !== fixture.key
    ) {
      throw new Error(`${fixture.id}: source URL does not match its fixed Level III key`);
    }
    const match = /^([A-Z0-9]{3})_N0S_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/.exec(fixture.key);
    if (!match) throw new Error(`${fixture.id}: unsupported N0S key format`);
    const [, id3, year, month, day, hour, minute, second] = match;
    if (fixture.station.slice(1) !== id3) {
      throw new Error(`${fixture.id}: station does not match its N0S key`);
    }
    assertKeyIdentity(fixture, fixture.station, `${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    return;
  }

  if (
    url.hostname !== "mesonet.agron.iastate.edu" ||
    fixture.bucket !== undefined ||
    fixture.key !== undefined ||
    fixture.etag !== undefined
  ) {
    throw new Error(`${fixture.id}: IEM reference metadata is not fixed-host or canonical`);
  }
  const extension = fixture.datasetKind === "iem_ridge_png" ? "png" : "wld";
  const match = /^\/archive\/data\/(\d{4})\/(\d{2})\/(\d{2})\/GIS\/ridge\/([A-Z0-9]{3})\/N0S\/\4_N0S_(\d{8})(\d{4})\.(png|wld)$/.exec(url.pathname);
  if (!match || match[7] !== extension || fixture.station.slice(1) !== match[4]) {
    throw new Error(`${fixture.id}: unsupported IEM RIDGE N0S path`);
  }
  const [, year, month, day, , compactDate, compactTime] = match;
  const expectedDate = `${year}${month}${day}`;
  const expectedTime = `${year}-${month}-${day}T${compactTime.slice(0, 2)}:${compactTime.slice(2)}:00Z`;
  if (compactDate !== expectedDate || fixture.observedAt !== expectedTime) {
    throw new Error(`${fixture.id}: scan time does not match its IEM RIDGE path`);
  }
}

function assertKeyIdentity(fixture, station, observedAt) {
  if (fixture.station !== station || fixture.observedAt !== observedAt) {
    throw new Error(`${fixture.id}: station or scan time does not match its fixed key`);
  }
}

function validateFixtureSets(fixtureSets, knownIds) {
  if (
    !fixtureSets
    || typeof fixtureSets !== "object"
    || Array.isArray(fixtureSets)
    || !Array.isArray(fixtureSets.phase4KtlxReflectivityLoop)
    || fixtureSets.phase4KtlxReflectivityLoop.length !== 20
    || !Array.isArray(fixtureSets.phase6N0sCorpus)
    || fixtureSets.phase6N0sCorpus.length < 4
    || !Array.isArray(fixtureSets.phase6TlxIemComparison)
    || fixtureSets.phase6TlxIemComparison.length < 3
  ) {
    throw new Error("Fixture manifest must define the 20-entry Phase 4 KTLX loop");
  }
  for (const [name, ids] of Object.entries(fixtureSets)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || !Array.isArray(ids) || ids.length === 0) {
      throw new Error(`Invalid fixture set ${name}`);
    }
    const uniqueIds = new Set(ids);
    if (
      uniqueIds.size !== ids.length
      || ids.some((id) => typeof id !== "string" || !knownIds.has(id))
    ) {
      throw new Error(`Fixture set ${name} contains a duplicate or unknown fixture ID`);
    }
  }
}

function isValidUtcTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(
    value,
  );
  if (!match) return false;

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
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
  const allowedHosts = new Set([
    "unidata-nexrad-level2.s3.amazonaws.com",
    "unidata-nexrad-level3.s3.amazonaws.com",
    "mesonet.agron.iastate.edu",
  ]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
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
