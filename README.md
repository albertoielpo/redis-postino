# redis-postino monorepo

Redis pub/sub messaging for Node.js microservices: load-balanced at-most-once delivery, broadcast, dead letter queue and error queue, built on [node-redis](https://github.com/redis/node-redis).

| Package                                             | Path              | Description                                                           |
| --------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| [`redis-postino`](packages/core/README.md)          | `packages/core`   | Framework-agnostic core                                               |
| [`nestjs-redis-postino`](packages/nestjs/README.md) | `packages/nestjs` | NestJS 12 module (decorators, injectable channels), built on the core |

Requirements: Node.js >= 24.15, Redis >= 7.2 standalone, or Redis Cluster (**experimental**). The packages are ESM only.

Migrating from the previous ioredis-based library? See [MIGRATION.md](MIGRATION.md).

## Local development

The repository uses npm workspaces, Lerna and Nx (build/test cache).

```bash
npm i            # install and link the workspace packages
npm run build    # build both packages (core first)
npm test         # unit tests (vitest)
npm run lint     # eslint
npm run format   # prettier
```

### Testing local changes in another project

```bash
npm run build
cd ../my-project && npm i <path-to-this-repo>/packages/nestjs   # or packages/core
```

Later builds are picked up without reinstalling. Remember to switch back to the published version afterwards.

## Commit guidelines

The Husky `pre-commit` hook runs `npm run test`, `npm run format`, `npm run lint` and `git add --all`. The commit is blocked if any of them fails.

Commit messages follow this format:

```
Action: Commit message
```

| Action   | Description                   |
| -------- | ----------------------------- |
| Breaking | Backwards-incompatible change |
| New      | New feature                   |
| Update   | Backwards-compatible change   |
| Fix      | Bug fix                       |
| Docs     | Documentation                 |
| Build    | Build process                 |
| Upgrade  | Dependency update             |
| Chore    | Refactor, tests, etc.         |

## License

[MIT](LICENSE) © Alberto Ielpo, Davide Stefania
