/**
 * Vite 8 hard-crashes on Node 21 (rolldown calls util.styleText with an array of
 * styles, which only Node 22+ accepts). The crash is a stack trace deep inside
 * rolldown and says nothing useful, so fail early with the actual fix instead.
 *
 * This machine's default `node` on PATH is an EOL 21.x; nvm has a supported 22.
 */

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;

if (!ok) {
  console.error(
    `\n  learn-piano needs Node 20.19+ or 22.12+. This shell has ${process.versions.node}.\n` +
      `  The repo pins the right version in .nvmrc, so:\n\n` +
      `      nvm use\n\n` +
      `  then run the command again.\n`
  );
  process.exit(1);
}
