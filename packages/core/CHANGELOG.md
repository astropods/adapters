# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.10.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.9.1...@astropods/adapter-core@0.10.0) (2026-08-31)


### Features

* **core,core-py:** expose saveConversation and getThreadHistory on StreamOptions ([#74](https://github.com/astropods/adapters/issues/74)) ([d6abb78](https://github.com/astropods/adapters/commit/d6abb7844e0f0d736ea8fb9ae3f4fae242a2acf0))



## [0.9.1](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.9.0...@astropods/adapter-core@0.9.1) (2026-08-10)

**Note:** Version bump only for package @astropods/adapter-core





## [0.9.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.8.0...@astropods/adapter-core@0.9.0) (2026-07-31)


### Features

* **adapters:** forward inbound images to the model (StreamOptions.images + Mastra multimodal) ([#71](https://github.com/astropods/adapters/issues/71)) ([274a484](https://github.com/astropods/adapters/commit/274a484ff4a0aad24e608fb0bc87ab88d7093edf))



## [0.8.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.7.0...@astropods/adapter-core@0.8.0) (2026-07-16)


### Features

* message attachments + onFile output hook (agent SDK) ([#66](https://github.com/astropods/adapters/issues/66)) ([f71ebc5](https://github.com/astropods/adapters/commit/f71ebc550c7f26023588c0f0c4b15a6f57e6b88f))



## [0.7.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.6.1...@astropods/adapter-core@0.7.0) (2026-07-10)


### Features

* **core:** agent-side render()/elicit() bridge for Renderables ([#59](https://github.com/astropods/adapters/issues/59)) ([a59d1b8](https://github.com/astropods/adapters/commit/a59d1b8330dc23ec2c6fbc0db7f04331d660e1d5))
* supply traceparent helper in core packages ([#64](https://github.com/astropods/adapters/issues/64)) ([fc10fb9](https://github.com/astropods/adapters/commit/fc10fb9dd5186a3e404d6e5b103beaaeceeab97a))



## [0.6.1](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.6.0...@astropods/adapter-core@0.6.1) (2026-07-06)


### Bug Fixes

* **chat:** honor stop-generation by aborting the model call ([#58](https://github.com/astropods/adapters/issues/58)) ([284106c](https://github.com/astropods/adapters/commit/284106c95bf736143c4749b0b81ead475c6348ab))



## [0.6.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.4.1...@astropods/adapter-core@0.6.0) (2026-06-17)


### Features

* **ai-sdk:** add Vercel AI SDK adapter ([#50](https://github.com/astropods/adapters/issues/50)) ([3f783b0](https://github.com/astropods/adapters/commit/3f783b0e94f816531aa7603c8b03893cfde3a34f))
* **core:** instrument outbound fetch with OpenTelemetry ([#48](https://github.com/astropods/adapters/issues/48)) ([4243b9e](https://github.com/astropods/adapters/commit/4243b9e4d6abc90dd2b18465e141ff150ce12f75))



## [0.5.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.4.1...@astropods/adapter-core@0.5.0) (2026-06-17)


### Features

* **ai-sdk:** add Vercel AI SDK adapter ([#50](https://github.com/astropods/adapters/issues/50)) ([3f783b0](https://github.com/astropods/adapters/commit/3f783b0e94f816531aa7603c8b03893cfde3a34f))
* **core:** instrument outbound fetch with OpenTelemetry ([#48](https://github.com/astropods/adapters/issues/48)) ([4243b9e](https://github.com/astropods/adapters/commit/4243b9e4d6abc90dd2b18465e141ff150ce12f75))



## [0.4.1](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.3.0...@astropods/adapter-core@0.4.1) (2026-06-05)

**Note:** Version bump only for package @astropods/adapter-core





## [0.4.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.1.0...@astropods/adapter-core@0.4.0) (2026-06-05)


### Features

* **core, core-py:** add on_feedback hook for inbound platform feedback ([c1ac7fa](https://github.com/astropods/adapters/commit/c1ac7fa80a35aa95d434dabddb3a06e0002bd56b))
* **core:** expose PlatformContext to adapters via StreamOptions ([ab6e309](https://github.com/astropods/adapters/commit/ab6e3097f184a3c20c0386dd22914f2fc12867ec))
* structured JSON logging for Loki level detection ([233d6b2](https://github.com/astropods/adapters/commit/233d6b2b4833411f5826cca6198c63f6507c30bd))


### Bug Fixes

* **adapters:** backfill empty user_id with "anonymous" before tracing ([#40](https://github.com/astropods/adapters/issues/40)) ([5ec841f](https://github.com/astropods/adapters/commit/5ec841f38e74f17493e38da4ff324d567034af50))
* preserve DEBUG env var behavior and update tests for pino logger ([1be5e88](https://github.com/astropods/adapters/commit/1be5e88135cd439e83c908affd2ccf358aaf6333))



## [0.3.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.2.0...@astropods/adapter-core@0.3.0) (2026-06-05)


### Features

* **core:** expose PlatformContext to adapters via StreamOptions ([ab6e309](https://github.com/astropods/adapters/commit/ab6e3097f184a3c20c0386dd22914f2fc12867ec))



## [0.2.0](https://github.com/astropods/adapters/compare/@astropods/adapter-core@0.1.0...@astropods/adapter-core@0.2.0) (2026-06-01)


### Features

* **core, core-py:** add on_feedback hook for inbound platform feedback ([c1ac7fa](https://github.com/astropods/adapters/commit/c1ac7fa80a35aa95d434dabddb3a06e0002bd56b))
* structured JSON logging for Loki level detection ([233d6b2](https://github.com/astropods/adapters/commit/233d6b2b4833411f5826cca6198c63f6507c30bd))


### Bug Fixes

* **adapters:** backfill empty user_id with "anonymous" before tracing ([#40](https://github.com/astropods/adapters/issues/40)) ([5ec841f](https://github.com/astropods/adapters/commit/5ec841f38e74f17493e38da4ff324d567034af50))
* preserve DEBUG env var behavior and update tests for pino logger ([1be5e88](https://github.com/astropods/adapters/commit/1be5e88135cd439e83c908affd2ccf358aaf6333))



## 0.1.0 (2026-03-09)


### Features

* add audio support to adapter interface ([d059066](https://github.com/astropods/adapters/commit/d05906643f761cd370be9be5de011aab061a57dd))
* **audio:** add transcript hook, diagnostic logging, and lerna publish-local ([fecf60c](https://github.com/astropods/adapters/commit/fecf60c713dace170236f94bdc8c9fbdfc8f1f61))


### Bug Fixes

* **audio:** set up audioAsReadable on audioConfig to avoid race condition ([fcf58f2](https://github.com/astropods/adapters/commit/fcf58f29f690ddffa0e1faab1e287cc8b6ac6fd3))
* **audio:** support concurrent audio messages with a Map ([b267776](https://github.com/astropods/adapters/commit/b2677760f16f46d8ce84659a4672329c6fa443b0))
* **audio:** warn when audioConfig arrives before pending audio message ([71d2f91](https://github.com/astropods/adapters/commit/71d2f919cfc14687140513fe7ec9ddf105248adc))
* handle [audio] messages correctly and add diagnostic logging ([b899694](https://github.com/astropods/adapters/commit/b899694234d931e46b57971d5203017369dac428))



## 0.0.9 (2026-02-25)

**Note:** Version bump only for package @astropods/adapter-core





## 0.0.8 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-core





## 0.0.7 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-core





## 0.0.6 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-core





## 0.0.5 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-core





## 0.0.4 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-core





## 0.0.3 (2026-02-24)

**Note:** Version bump only for package @astropods/adapter-core
