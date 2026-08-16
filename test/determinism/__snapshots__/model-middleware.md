# model-middleware

## streaming=false

roles: core, example, test
model-middleware-example.ts: ~ function line
model-middleware-example.ts: ~ function main
model-middleware-example.ts: ~ function provider
model-middleware-example.ts: ~ import "./model-middleware.js"#2
model-middleware-example.ts: - interface Part
model-middleware.test-d.ts: ~ const model
model-middleware.test-d.ts: ~ import "./model-middleware.js"#2
model-middleware.test-d.ts: - interface Part
model-middleware.test-d.ts: ~ type ALayerOverTheBoundIsRefused
model-middleware.test-d.ts: ~ type StillTheSameModel
model-middleware.test.ts: ~ describe("caching")
model-middleware.test.ts: ~ describe("falling back to another model")
model-middleware.test.ts: - describe("streams are not started early")
model-middleware.test.ts: ~ describe("telemetry")
model-middleware.test.ts: ~ describe("wrapping a model")
model-middleware.test.ts: - function collect
model-middleware.test.ts: ~ function scripted
model-middleware.test.ts: ~ function tap
model-middleware.test.ts: - function textOf
model-middleware.test.ts: ~ import "./model-middleware.js"#2
model-middleware.test.ts: - interface Part
model-middleware.test.ts: ~ interface Script
model-middleware.test.ts: ~ interface Scripted
model-middleware.ts: ~ function generateChain
model-middleware.ts: ~ function memoryStore
model-middleware.ts: - function streamChain
model-middleware.ts: ~ function withCache
model-middleware.ts: ~ function withDefaults
model-middleware.ts: ~ function withFallback
model-middleware.ts: ~ function withTelemetry
model-middleware.ts: ~ function wrapModel
model-middleware.ts: ~ interface CacheOptions
model-middleware.ts: ~ interface CacheStore
model-middleware.ts: ~ interface CallReport
model-middleware.ts: ~ interface FallbackOptions
model-middleware.ts: ~ interface Middleware
model-middleware.ts: - interface MinimalPart
model-middleware.ts: - interface StreamingModel
model-middleware.ts: - type CacheEntry
model-middleware.ts: ~ type JsonSchema
model-middleware.ts: + interface CacheEntry

## caching=false

roles: core, example, test
model-middleware-example.ts: ~ function main
model-middleware-example.ts: ~ import "./model-middleware.js"
model-middleware.test.ts: - describe("caching")
model-middleware.test.ts: ~ import "./model-middleware.js"
model-middleware.ts: - function cacheKey
model-middleware.ts: - function memoryStore
model-middleware.ts: - function repeatable
model-middleware.ts: - function withCache
model-middleware.ts: - interface CacheOptions
model-middleware.ts: - interface CacheStore
model-middleware.ts: - type CacheEntry

## fallback=false

roles: core, example, test
model-middleware-example.ts: ~ function main
model-middleware-example.ts: ~ import "./model-middleware.js"
model-middleware.test.ts: - describe("falling back to another model")
model-middleware.test.ts: ~ import "./model-middleware.js"
model-middleware.ts: - function withFallback
model-middleware.ts: - function worthAnotherModel
model-middleware.ts: ~ interface CacheOptions
model-middleware.ts: ~ interface CallReport
model-middleware.ts: - interface FallbackOptions

## includeTests=false

roles: test
-file model-middleware.test-d.ts
-file model-middleware.test.ts
