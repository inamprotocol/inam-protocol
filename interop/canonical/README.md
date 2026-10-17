# Canonical JSON: non-ASCII and non-BMP vectors

`vectors.json` holds inputs and the exact canonical string (plus `sha256` of its UTF-8 bytes) that every SDK must produce. It covers what ASCII-only vectors cannot: key order for astral characters (UTF-16 code unit order, as in RFC 8785, so an emoji key sorts before `U+FFFF`), emoji and ZWJ sequences, no Unicode normalization, lone surrogates (escaped as `\udXXX`), control characters.

Checked by `tests/canonicalVectors.test.ts` (JS) and `sdk-python/tests/test_canonical_vectors.py` (Python). Regenerate with `npx tsx interop/canonical/generate.ts`.
