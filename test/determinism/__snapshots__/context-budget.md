# context-budget

## strategy=summarise

roles: core, example, test
context-budget-example.ts: ~ const BUDGET
context-budget-example.ts: ~ function main
context-budget.test-d.ts: + function theStrategyNeedsItsOwnFields
context-budget.test.ts: ~ const ESTIMATED
context-budget.test.ts: ~ const EXACT
context-budget.test.ts: ~ describe("a tool call and the results answering it")
context-budget.test.ts: ~ describe("choosing which turns to send")
context-budget.test.ts: ~ describe("the arithmetic")
context-budget.test.ts: ~ describe("the default estimate")
context-budget.test.ts: ~ describe("what cannot be made to fit")
context-budget.test.ts: ~ function fit
context-budget.test.ts: ~ function refusalOf
context-budget.test.ts: + describe("the summary")
context-budget.ts: ~ function fitToBudget
context-budget.ts: ~ function fitted
context-budget.ts: ~ interface Budget
context-budget.ts: ~ interface Fitted
context-budget.ts: ~ interface TextPart
context-budget.ts: + function withSummary

## strategy=middle-out

roles: core, example, test
context-budget-example.ts: ~ const BUDGET
context-budget.test-d.ts: + function theStrategyNeedsItsOwnFields
context-budget.test.ts: ~ const ESTIMATED
context-budget.test.ts: ~ const EXACT
context-budget.test.ts: + describe("keeping both ends")
context-budget.ts: ~ function fitToBudget
context-budget.ts: ~ function select
context-budget.ts: ~ interface Budget
context-budget.ts: ~ interface TextPart

## toolPairing=false

roles: core, example, test
context-budget-example.ts: ~ const BUDGET
context-budget-example.ts: ~ const CHAT
context-budget-example.ts: - function found
context-budget-example.ts: - function lookedUp
context-budget-example.ts: ~ import "./context-budget.js"#2
context-budget.test-d.ts: - type PortIsMeasurable
context-budget.test-d.ts: + type NotAssignable
context-budget.test-d.ts: + type PortIsRefused
context-budget.test.ts: - describe("a tool call and the results answering it")
context-budget.test.ts: ~ describe("the arithmetic")
context-budget.test.ts: - function answered
context-budget.test.ts: - function called
context-budget.test.ts: ~ function labelOf
context-budget.test.ts: ~ import "./context-budget.js"#2
context-budget.ts: - function answers
context-budget.ts: - function callIdsOf
context-budget.ts: ~ function costOf
context-budget.ts: ~ function fitToBudget
context-budget.ts: - function jsonText
context-budget.ts: - function textOf
context-budget.ts: ~ function unitsOf
context-budget.ts: ~ interface AssistantMessage
context-budget.ts: ~ interface Budget
context-budget.ts: ~ interface Fitted
context-budget.ts: ~ interface TextPart
context-budget.ts: - interface ToolCallPart
context-budget.ts: - interface ToolMessage
context-budget.ts: - interface ToolResultPart
context-budget.ts: ~ interface Unit
context-budget.ts: ~ type Message

## onOverflow=throw

roles: core, example, test
context-budget-example.ts: ~ function main
context-budget-example.ts: ~ import "./context-budget.js"
context-budget.test-d.ts: - function overflowHasNoMessages
context-budget.test-d.ts: ~ import "./context-budget.js"
context-budget.test.ts: ~ function fit
context-budget.test.ts: ~ function refusalOf
context-budget.test.ts: ~ import "./context-budget.js"
context-budget.test.ts: ~ import "./context-budget.js"#2
context-budget.ts: ~ function fitToBudget
context-budget.ts: ~ function fitted
context-budget.ts: ~ function refused
context-budget.ts: ~ interface Fitted
context-budget.ts: - interface Overflow
context-budget.ts: - type Budgeted
context-budget.ts: + class ContextOverflowError

## includeTests=false

roles: test
-file context-budget.test-d.ts
-file context-budget.test.ts
