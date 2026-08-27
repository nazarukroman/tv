import { CHANNELS, DEFAULT_FAVOURITES } from '../config/channels.ts';

/**
 * The client assets, built from source at start-up.
 *
 * The scripts used to be template strings in this directory. That was cheap
 * and it cost more than it saved: `tsc` never looked inside them, the linter
 * never looked inside them, no test could import them, and a slug renamed in
 * `config/channels.ts` desynchronised the selectors in the client with nothing
 * anywhere reporting it. They are ordinary modules under `src/client/` now,
 * type-checked against DOM globals and tested with the rest of the code.
 *
 * Building happens in the process rather than in a build step, and that is a
 * deliberate constraint on the Dockerfile: the image copies sources and runs
 * them, with no toolchain and no artefacts to keep in sync. Two builds cost
 * tens of milliseconds, once, on a container that then runs for weeks — the
 * same trade the rest of this program makes, which is to do the work when the
 * data changes rather than when a request arrives.
 *
 * The two halves are delivered differently on purpose. The boot script is
 * inlined because it must run before the first paint and cannot afford a round
 * trip. The application is a hashed, immutable asset because it is identical
 * on all fifteen day pages, and the day tabs are ordinary links: inlining it
 * would re-send the same four kilobytes on every day the visitor looks at.
 */

const CLIENT_DIR = `${import.meta.dir}/../client`;

/**
 * The channel list is substituted in rather than read from the document.
 * The boot script needs it before any markup exists, to tell a stale slug in
 * `localStorage` from a real one — without that check an old favourite would
 * hide all twenty columns and the page would come up empty.
 */
const DEFINE: Record<string, string> = {
  __SLUGS__: JSON.stringify(CHANNELS.map((channel) => channel.slug)),
  __DEFAULT_FAVOURITES__: JSON.stringify(DEFAULT_FAVOURITES),
};

async function build(entrypoint: string, define?: Record<string, string>): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    format: 'iife',
    minify: true,
    ...(define === undefined ? {} : { define }),
  });

  if (!result.success || result.outputs[0] === undefined) {
    // Failing here takes the container down before it can serve anything,
    // which is right: a page whose boot script is missing shows every channel
    // to someone who picked six, and still looks like working software.
    throw new Error(`failed to build ${entrypoint}:\n${result.logs.map(String).join('\n')}`);
  }
  return result.outputs[0].text();
}

/** Inlined into `<head>`, so it must not be able to close the tag around it. */
async function buildInline(entrypoint: string, define?: Record<string, string>): Promise<string> {
  const code = await build(entrypoint, define);
  if (code.includes('</script') || code.includes('</style')) {
    throw new Error(`${entrypoint} contains an end tag and cannot be inlined safely`);
  }
  return code;
}

export const STYLES: string = await buildInline(`${import.meta.dir}/styles.css`);
export const BOOT_SCRIPT: string = await buildInline(`${CLIENT_DIR}/boot.ts`, DEFINE);

const appCode = await build(`${CLIENT_DIR}/app.ts`, DEFINE);

/**
 * The application bundle, addressed by its own content.
 *
 * A content hash in the path is what lets the response be cached for a year:
 * a deploy that changes the code changes the URL, so there is no invalidation
 * to get wrong and no window in which a cached page pulls a stale script.
 */
export const APP_ASSET: { readonly path: string; readonly code: string } = {
  path: `/app.${Bun.hash(appCode).toString(36)}.js`,
  code: appCode,
};
