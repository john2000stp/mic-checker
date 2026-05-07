# Mic Checker

Real-time microphone diagnostics in the browser. Built with Bun, React, and the Web Audio API.

## What it does

Captures your microphone input and gives you instant feedback on whether it's suitable for dictation and speech recognition:

- **VU Meter** — live input level with peak hold and clipping detection
- **Speech Band Energy** — measures what percentage of captured sound falls in the 300 Hz–3.4 kHz range that carries speech intelligibility
- **Voice Activity Detection** — automatically detects when you're speaking vs. silent, tracks dynamic range between the two states, and shows a 2.5-second activity history
- **Waveform** — oscilloscope view of the raw audio signal
- **Frequency Spectrum** — FFT visualizer with the speech band highlighted
- **Signal Quality rating** — overall SNR-based score (Excellent / Good / Fair / Poor)
- **Noise floor estimate** — how loud your mic is when you're not speaking

Every metric has an info tooltip explaining it in plain terms.

## Getting started

```bash
bun install
bun --hot index.ts
```

Then open [http://localhost:3000](http://localhost:3000), click **Start Mic Check**, and allow microphone access.

## Tech

- [Bun](https://bun.sh) — runtime, bundler, dev server
- React 19
- Web Audio API (`AnalyserNode`, `AudioContext`)
- No other runtime dependencies

## License

MIT
