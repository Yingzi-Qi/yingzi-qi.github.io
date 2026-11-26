# Tillroll golden set

The fixtures in this directory use synthetic OCR, catalogue IDs, and image hashes. The scorer follows the production path through strict OCR parsing, `buildSanityPayload`, the deterministic server catalogue, the receipt gate, workbook export, and workbook read-back.

Run the default synthetic batch with the bundled Node runtime.

```sh
$NODE tests/golden/golden-scorer.mjs --issues
$NODE --test tests/golden/golden.test.mjs
```

Pass one private JSON dataset when validating a local batch. Keep it outside the repository or under the ignored `tests/golden-local/` directory.

```sh
$NODE tests/golden/golden-scorer.mjs /path/to/golden.json --json
```

Each dataset has `asOf`, `catalogue`, and `fixtures`. A fixture supplies `id`, OCR lines, and `expected`. `expected.gate` is `pass` or `review`. Review fixtures must have zero expected main-sheet rows and a `reviewReason`. Passing fixtures must specify every one of the ten visible columns for every unit row. Expected blank cells must carry a Pink or Amber flag with evidence and a reason substring.

The scorer prints the receipt, row, field, expected value, exported value, status, written reason, and evidence. It also reports per-column accuracy, clean-receipt percentage, exported receipt count, exported gate-pass percentage, wrong values, Pink cells, Amber cells, and unsupported flags. Any wrong value, unsupported flag, unexpected output, or failed review gate returns a non-zero exit status.

Private receipt photographs and identifiers never belong in this directory or the public repository.
