export function parseFixtureVerificationArgs(args) {
  let shouldDownload = false;
  let setName;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--download" && !shouldDownload) {
      shouldDownload = true;
    } else if (argument === "--set" && setName === undefined && args[index + 1]) {
      setName = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unsupported fixture verifier argument: ${argument}`);
    }
  }
  return { shouldDownload, setName };
}

export function selectFixturesForVerification(fixtures, fixtureSets, setName) {
  if (setName === undefined) return [...fixtures];
  const ids = fixtureSets?.[setName];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`Unknown or empty fixture set: ${setName}`);
  }
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  return ids.map((id) => {
    const fixture = byId.get(id);
    if (!fixture) throw new Error(`Fixture set ${setName} references unknown fixture ${id}`);
    return fixture;
  });
}
