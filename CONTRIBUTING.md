# Contributing to @floelabs/cli

Thanks for your interest in contributing to the Floe CLI.

## Getting Started

Requires Node.js `>=18.17` and pnpm (CI pins `8.15.0`).

```bash
git clone https://github.com/Floe-Labs/floe-cli.git
cd floe-cli
pnpm install
pnpm build
```

## Development

```bash
pnpm build       # Build with tsup → dist/
pnpm typecheck   # Type check
pnpm test        # Run tests (vitest)
pnpm test:watch  # Tests in watch mode
```

Run `pnpm build` before trying the CLI locally — it runs from built output (`node dist/bin.js`).

## Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code, add tests
3. Ensure `pnpm build`, `pnpm typecheck`, and `pnpm test` pass
4. Write a clear PR description explaining the change

## Code Style

- TypeScript strict mode, ESM
- **Zero runtime dependencies.** Use Node built-ins (`fetch`, `util.parseArgs`, `node:readline`). The only exception is the optional `@napi-rs/keyring` keychain binding, which must keep its graceful fallback
- No `any` types without justification

## Reporting Bugs

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Security Issues

See [SECURITY.md](SECURITY.md) — do **not** open a public issue for security vulnerabilities.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
