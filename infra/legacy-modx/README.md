# Legacy MODX MySQL (Phase 6.5 extract source)

Boots MySQL 5.7 from the repo-root dump `ce39229_myorl.sql` for the
Phase 6.5 content hydration extract. See [issue #14](https://github.com/bagtyyarkovusov/myorl-migrate/issues/14)
and `plans/gh-issue-6_5-content-hydration.md` for context.

## Start

```sh
cd apps/strapi
pnpm legacy:up
```

First boot imports the dump into `mysql://root:modx@127.0.0.1:3307/modx`.
Subsequent boots reuse the `modx-mysql-data` named volume (fast).

Readiness probe:

```sh
docker compose -f infra/legacy-modx/docker-compose.yml ps
```

Healthy when `STATUS` shows `healthy`. `pnpm legacy:up` waits on this, and the extractor also retries the real MySQL connection if you start the container manually.

## Reset (destroy + re-import the dump)

```sh
cd /path/to/myorl-migrate
docker compose -f infra/legacy-modx/docker-compose.yml down -v
docker compose -f infra/legacy-modx/docker-compose.yml up -d
```

`-v` drops the named volume; next boot re-runs the init script.

## Stop

```sh
cd apps/strapi
pnpm legacy:down
```

Container stops, data volume preserved.

## Connect manually

```sh
mysql -h 127.0.0.1 -P 3307 -uroot -pmodx modx
```

Or from the extractor:

```
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=root MYSQL_PASSWORD=modx MYSQL_DATABASE=modx
```

These defaults are baked into `apps/strapi/scripts/extract-modx.ts`; override
via env if needed.
