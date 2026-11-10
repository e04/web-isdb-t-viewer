# Conservative decoder performance improvements

This change accelerates the existing decoder without changing the 64-tap FIR,
sample rate, capture window, puncture-phase search, or number of decoder workers.
It does not include UI, tuner-support, scheduler, or AAC changes.

## What changed

- Replace per-sample trigonometry in tuner mixing and OFDM CFO correction with a
  complex oscillator, anchored to the absolute sample position every 1024 samples.
- Cache the constant fractional-resampler coefficient table and move boundary
  checks outside its inner tap loop; preserve coefficients and summation order.
- Use `sqrt(a*a + b*b)` for bounded 8-bit-IQ CP correlations, avoiding the scaled
  `hypot` algorithm in the hot loop.
- Pack eight Viterbi decisions into one byte before writing them, reuse generator
  signs, and find the maximum path metric only when normalization is required.
  Keep Float64 metrics, arithmetic order, tie-breaking, and traceback unchanged.

The rotating-phasor and bounded-magnitude approaches also appear in
[Fuku856's performance commit](https://github.com/Fuku856/web-isdb-t-viewer-V4/commit/c9847574223bcaee6554a294b51379ccefc7bf7e).
That fork is valuable prior art, not a competing implementation to discard.
The numerical regression tests and Viterbi-loop optimization here are complementary.

## Reproducible synthetic benchmark

```sh
node scripts/benchmark-decoder.mjs
```

Pass checkout directories to compare revisions in one process:

```sh
node scripts/benchmark-decoder.mjs ../baseline ../v4 .
```

The script uses identical seeded six-second 8-bit noise IQ, retains spectrum and
constellation generation in every implementation, and runs an additional
representative rate-2/3 Viterbi workload. It alternates execution order, discards
the first round, and reports medians of three subsequent rounds.
Only one Viterbi pass is timed. Noise does not provide a valid TMCC/transport, so
this is deliberately **not** an end-to-end reception benchmark.

One Windows / Node.js 22.23.4 comparison:

| Version            | DSP median | Viterbi median | Combined median |
| ------------------ | ---------: | -------------: | --------------: |
| Upstream `364e225` |    4850 ms |        1330 ms |         6138 ms |
| Fuku856 `c984757`  |    1154 ms |        1341 ms |         2480 ms |
| This contribution  |    1366 ms |         847 ms |         2196 ms |

Medians are calculated independently; the component medians need not sum to the
combined median. Timings vary with CPU, runtime, GC, system load, and run order.
The fork's DSP is faster with its 32-tap FIR. This contribution's combined result
is faster in this particular workload because its Viterbi loop is cheaper; this
does not establish an overall winner on other devices or broadcasts.

USB, MSE/AAC playback, packet alignment/RS, repeated phase-search attempts,
monitoring-worker contention, parallel throughput, thermal behavior, and Android
have not been benchmarked by this script.

## Why not take every optimization at once?

- **32-tap FIR:** promising, but changes the filter. A separate numerical grid
  evaluation of all 1024 phases, 129 passband points in 0..0.105 cycles/input
  sample and 129 stopband points in 0.39..0.5 found the fork's worst stopband
  response around -82.19 dB, versus -94.85 dB for the original 64-tap design.
  The fork's passband stayed within approximately -0.00036..+0.00248 dB.
  This supports evaluating it separately; it is not evidence that the shorter
  filter causes reception problems. This PR preserves the existing response.
- **Two decoder workers:** potentially better throughput, but concurrent
  six-second DSP jobs also increase peak memory and CPU contention. A separate
  scheduler/mobile-memory evaluation is needed.
- **Prefix-only puncture-phase probing:** cheaper when the correct phase would
  otherwise need several full decodes, but a damaged prefix can reject a capture
  whose later data is useful. On synthetic rate-2/3 soft input with an initial
  80-packet corrupted region followed by clean data, the fork's actual phase
  selection returned a score of about 0.059 and rejected the capture, whereas
  the original selection scored about 0.522 and continued to packet decoding.
  This isolated test injected TMCC/deinterleaving output and did not verify RS
  recovery. A full-input fallback should be evaluated before changing acquisition.
- **AAC repairs and receiver diagnostics:** independent from these hot loops and
  intentionally left for separate changes.

## Correctness checks

- Compare the recursive oscillator with direct trigonometry around +/-400 kHz,
  at sample-rate tolerance boundaries, near both ends of a six-second capture,
  and across oscillator re-anchoring boundaries.
- Compare FIR output exactly with the original zero-padded sum.
- Compare all four guard intervals, CFO, symbol counts, and complex FFT output
  with the original synchronization algorithm.
- Compare Viterbi bits exactly with the original at all five rates and every
  puncture phase, including random, discrete/tied, and all-zero soft inputs.
- Preserve existing tests, including no false lock on noise/DC.

The external real-IQ fixture is not included in the repository; its existing
test remains skipped when absent. These synthetic checks do not replace RF
testing on diverse stations and devices.
