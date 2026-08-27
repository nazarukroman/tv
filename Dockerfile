# Pinned by digest-bearing tag rather than `:latest`: nothing on the host ever
# pulls on its own, so a floating tag would simply freeze at whatever was
# cached when the container was first created.
FROM oven/bun:1.4.0-alpine

WORKDIR /app

# No build step and no runtime dependencies — Bun ships the SQLite driver, the
# HTTP server and the bundler, and the page is rendered from TypeScript
# directly. The client bundle is built by the process itself at start-up, which
# is why only sources are copied: there is no artefact here that could drift
# out of sync with them. Only the dev toolchain lives in package.json, so
# nothing is installed.
COPY package.json ./
COPY src/ src/

# Must match the uid that owns the database on the host bind mount. A mismatch
# does not fail the start; it surfaces as a silently read-only database, which
# looks like an app that has simply stopped updating.
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app \
    && mkdir -p /app/data && chown -R app:app /app
USER app

ENV TV_DB=/app/data/tv.db
ENV TV_PORT=4300

EXPOSE 4300

# Serves first, fetches second: the guide answers from stored data even when
# the upstream feed is unreachable at startup.
CMD ["bun", "run", "src/main.ts"]
