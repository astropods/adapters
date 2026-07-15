# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.5.0](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.4.5...@astropods/adapter-mastra@0.5.0) (2026-07-10)


### Features

* use trace context helper in framework packages ([#65](https://github.com/astropods/adapters/issues/65)) ([c6eeb37](https://github.com/astropods/adapters/commit/c6eeb379f04fcdf80fbf03c5763dcecc9c92cfca))



## [0.4.5](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.4.4...@astropods/adapter-mastra@0.4.5) (2026-07-10)


### Bug Fixes

* **mastra:** adapt to upstream changes for @mastra/core@1.50.0 ([#57](https://github.com/astropods/adapters/issues/57)) ([d79b245](https://github.com/astropods/adapters/commit/d79b245ae641106aa510687c1a25bab3d5013986))



## [0.4.4](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.4.3...@astropods/adapter-mastra@0.4.4) (2026-07-06)


### Bug Fixes

* **chat:** honor stop-generation by aborting the model call ([#58](https://github.com/astropods/adapters/issues/58)) ([284106c](https://github.com/astropods/adapters/commit/284106c95bf736143c4749b0b81ead475c6348ab))



## [0.4.3](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.4.1...@astropods/adapter-mastra@0.4.3) (2026-06-17)

**Note:** Version bump only for package @astropods/adapter-mastra





## [0.4.2](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.4.1...@astropods/adapter-mastra@0.4.2) (2026-06-17)

**Note:** Version bump only for package @astropods/adapter-mastra





## [0.4.1](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.3.1...@astropods/adapter-mastra@0.4.1) (2026-06-05)

**Note:** Version bump only for package @astropods/adapter-mastra





## [0.4.0](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.1.0...@astropods/adapter-mastra@0.4.0) (2026-06-05)


### Features

* auto-configure OTEL tracing in mastra adapter ([08d59a8](https://github.com/astropods/adapters/commit/08d59a86f09bfb1ca62fd41b4a78bb22a11146ef))
* structured JSON logging for Loki level detection ([233d6b2](https://github.com/astropods/adapters/commit/233d6b2b4833411f5826cca6198c63f6507c30bd))


### Bug Fixes

* **adapters:** backfill empty user_id with "anonymous" before tracing ([#40](https://github.com/astropods/adapters/issues/40)) ([5ec841f](https://github.com/astropods/adapters/commit/5ec841f38e74f17493e38da4ff324d567034af50))
* **mastra:** enrich Mastra traces with langfuse.user.id and langfuse.session.id ([c0a809e](https://github.com/astropods/adapters/commit/c0a809e6c21154789da016b2c9104c3b842ce7f3))
* update tests to mock logger instead of console spies ([bf1dff3](https://github.com/astropods/adapters/commit/bf1dff31a0b596afdab82c87e709db83fe4d8188))



## [0.3.1](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.3.0...@astropods/adapter-mastra@0.3.1) (2026-06-05)

**Note:** Version bump only for package @astropods/adapter-mastra





## [0.3.0](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.2.0...@astropods/adapter-mastra@0.3.0) (2026-06-01)


### Features

* structured JSON logging for Loki level detection ([233d6b2](https://github.com/astropods/adapters/commit/233d6b2b4833411f5826cca6198c63f6507c30bd))


### Bug Fixes

* **adapters:** backfill empty user_id with "anonymous" before tracing ([#40](https://github.com/astropods/adapters/issues/40)) ([5ec841f](https://github.com/astropods/adapters/commit/5ec841f38e74f17493e38da4ff324d567034af50))
* **mastra:** enrich Mastra traces with langfuse.user.id and langfuse.session.id ([c0a809e](https://github.com/astropods/adapters/commit/c0a809e6c21154789da016b2c9104c3b842ce7f3))
* update tests to mock logger instead of console spies ([bf1dff3](https://github.com/astropods/adapters/commit/bf1dff31a0b596afdab82c87e709db83fe4d8188))



## [0.2.0](https://github.com/astropods/adapters/compare/@astropods/adapter-mastra@0.1.0...@astropods/adapter-mastra@0.2.0) (2026-03-19)


### Features

* auto-configure OTEL tracing in mastra adapter ([08d59a8](https://github.com/astropods/adapters/commit/08d59a86f09bfb1ca62fd41b4a78bb22a11146ef))



## 0.1.0 (2026-03-09)


### Features

* add audio support to adapter interface ([d059066](https://github.com/astropods/adapters/commit/d05906643f761cd370be9be5de011aab061a57dd))


### Bug Fixes

* **audio:** call onTranscript after STT to update user message placeholder ([9a0f860](https://github.com/astropods/adapters/commit/9a0f86007720a4ab309167a81ea12b5562de9fa3))
* **audio:** log TTS errors instead of swallowing them silently ([182b70a](https://github.com/astropods/adapters/commit/182b70a8806df2996e34edb917c8a128daafe141))
* **audio:** use single LLM call for streamAudio with accumulated text for TTS ([f8b00c6](https://github.com/astropods/adapters/commit/f8b00c60a2e1004c3e35ff47e46c9d933100bd3c))
* handle [audio] messages correctly and add diagnostic logging ([b899694](https://github.com/astropods/adapters/commit/b899694234d931e46b57971d5203017369dac428))



## 0.0.9 (2026-02-25)

**Note:** Version bump only for package @astropods/adapter-mastra





## 0.0.8 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-mastra





## 0.0.7 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-mastra





## 0.0.6 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-mastra





## 0.0.5 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-mastra





## 0.0.4 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-mastra





## 0.0.3 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-mastra
