# Contributing

Changes must preserve monotonic behavior.

1. Add a failing fixture or regression test.
2. Keep the optimization behind a default-off feature flag.
3. Preserve raw bytes and relevant source-state evidence.
4. Compare with the exact tokenizer used by production.
5. Select only when the candidate is strictly smaller.
6. Record rejected attempts as well as wins.
7. Keep observed measurements separate from replay and projections.

Run wrapper tests:

```sh
npm test
```

Verify the patch:

```sh
git clone --depth 1 --branch rust-v0.145.0-alpha.30 https://github.com/openai/codex.git upstream
git -C upstream apply --check ../patches/codex-rust-v0.145.0-alpha.30.patch
```

Rust changes should use the upstream Codex formatting, lint, and focused-test guidance. Do not include private session logs, prompt manifests, raw artifacts, local paths, or credentials in a pull request.
