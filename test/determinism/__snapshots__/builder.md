# builder

## completeness=result

roles: core, example, test
order-builder-example.ts: - const noSuchField
order-builder-example.ts: - const notACollection
order-builder-example.ts: - const partial
order-builder-example.ts: - const tooEarly
order-builder-example.ts: - const wrongType
order-builder-example.ts: - function label
order-builder-example.ts: ~ function readdressed
order-builder-example.ts: ~ import "./order-builder.js"
order-builder-example.ts: ~ interface ShipmentLabel
order-builder-example.ts: + function describeLabel
order-builder-example.ts: + function labelFrom
order-builder-example.ts: + import "./order-builder.js"#2
order-builder.test.ts: ~ describe("createOrderBuilder")
order-builder.test.ts: ~ function started
order-builder.test.ts: ~ import "./order-builder.js"
order-builder.test.ts: ~ import "vitest"
order-builder.test.ts: + const required
order-builder.test.ts: + function built
order-builder.test.ts: + import "./order-builder.js"#2
order-builder.ts: ~ function createOrderBuilder
order-builder.ts: ~ function createOrderBuilderFrom
order-builder.ts: ~ function step
order-builder.ts: - interface OrderBuilderSteps
order-builder.ts: - interface OrderMissingRequired
order-builder.ts: - type OrderBuildStep
order-builder.ts: - type OrderBuilder
order-builder.ts: - type OrderRequiredKeys
order-builder.ts: + function describeOrderBuildFailure
order-builder.ts: + interface OrderBuildFailure
order-builder.ts: + interface OrderBuilder
order-builder.ts: + type OrderBuildOutcome

## completeness=throw

roles: core, example, test
order-builder-example.ts: - const noSuchField
order-builder-example.ts: - const notACollection
order-builder-example.ts: - const partial
order-builder-example.ts: - const tooEarly
order-builder-example.ts: - const wrongType
order-builder-example.ts: - function label
order-builder-example.ts: ~ function readdressed
order-builder-example.ts: ~ import "./order-builder.js"
order-builder-example.ts: ~ interface ShipmentLabel
order-builder-example.ts: + function describeLabel
order-builder-example.ts: + function labelFrom
order-builder.test.ts: ~ describe("createOrderBuilder")
order-builder.test.ts: ~ function started
order-builder.test.ts: ~ import "./order-builder.js"
order-builder.test.ts: ~ import "vitest"
order-builder.test.ts: + const required
order-builder.ts: ~ function createOrderBuilder
order-builder.ts: ~ function createOrderBuilderFrom
order-builder.ts: ~ function step
order-builder.ts: - interface OrderBuilderSteps
order-builder.ts: - interface OrderMissingRequired
order-builder.ts: - type OrderBuildStep
order-builder.ts: - type OrderBuilder
order-builder.ts: - type OrderRequiredKeys
order-builder.ts: + class OrderBuildError
order-builder.ts: + function describeOrderBuildFailure
order-builder.ts: + interface OrderBuildFailure
order-builder.ts: + interface OrderBuilder

## collections=false

roles: core, example, test
order-builder-example.ts: - const notACollection
order-builder-example.ts: ~ function label
order-builder-example.ts: ~ interface ShipmentLabel
order-builder.test.ts: ~ describe("createOrderBuilder")
order-builder.test.ts: ~ interface Label
order-builder.ts: ~ function step
order-builder.ts: ~ interface OrderBuilderSteps
order-builder.ts: - type OrderCollectionItem
order-builder.ts: - type OrderCollectionKey

## includeTests=false

roles: test
-file order-builder.test.ts
