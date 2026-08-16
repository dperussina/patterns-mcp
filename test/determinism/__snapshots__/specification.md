# specification

## composition=free

roles: core, example, test
order-specification-example.ts: ~ const collectable
order-specification-example.ts: ~ const ignorable
order-specification-example.ts: ~ function refusesToNarrowThroughNegation
order-specification-example.ts: ~ import "./order-specification.js"
order-specification-example.ts: + const everything
order-specification-example.ts: + function anyOf
order-specification-example.ts: + function refusesAnEmptyCombination
order-specification.test-d.ts: ~ const bothFiltered
order-specification.test-d.ts: ~ const deeplyFiltered
order-specification.test-d.ts: ~ const either
order-specification.test-d.ts: ~ const negated
order-specification.test-d.ts: ~ import "./order-specification.js"
order-specification.test-d.ts: + const gathered
order-specification.test-d.ts: + type VariadicRefines
order-specification.test.ts: ~ describe("composition")
order-specification.test.ts: ~ describe("translation")
order-specification.test.ts: ~ import "./order-specification.js"
order-specification.test.ts: + describe("gathering rules")
order-specification.ts: ~ function specification
order-specification.ts: ~ interface OrderSpecification
order-specification.ts: + function and
order-specification.ts: + function every
order-specification.ts: + function not
order-specification.ts: + function or
order-specification.ts: + function some
order-specification.ts: + type RefinedBy

## translation=false

roles: core, example, test
order-specification-example.ts: ~ const cancelled
order-specification-example.ts: ~ const paid
order-specification-example.ts: ~ const substantial
order-specification-example.ts: - function collectableRows
order-specification-example.ts: - function describe
order-specification-example.ts: - function refusesAMagnitudeOnText
order-specification-example.ts: - function refusesAnImpossibleValue
order-specification-example.ts: - function refusesAnUnknownField
order-specification-example.ts: ~ import "./order-specification.js"
order-specification-example.ts: ~ import "./order-specification.js"#2
order-specification.test-d.ts: ~ const cancelled
order-specification.test-d.ts: ~ const paid
order-specification.test-d.ts: ~ const substantial
order-specification.test-d.ts: ~ import "./order-specification.js"
order-specification.test.ts: ~ const cancelled
order-specification.test.ts: ~ const paid
order-specification.test.ts: ~ const substantial
order-specification.test.ts: - describe("translation")
order-specification.test.ts: ~ import "./order-specification.js"
order-specification.ts: - const OPERATORS
order-specification.ts: - function render
order-specification.ts: ~ function specification
order-specification.ts: - function toSql
order-specification.ts: - function whereAtLeast
order-specification.ts: - function whereAtMost
order-specification.ts: - function whereEquals
order-specification.ts: - interface OrderCriterion
order-specification.ts: ~ interface OrderSpecification
order-specification.ts: - type NumericField
order-specification.ts: - type OrderQuery
order-specification.ts: + function refine
order-specification.ts: + function specify

## includeTests=false

roles: test
-file order-specification.test-d.ts
-file order-specification.test.ts
