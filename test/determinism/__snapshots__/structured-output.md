# structured-output

## strategy=response-format

roles: core, example, test
structured-output-example.ts: ~ function extractOrder
structured-output.test.ts: ~ describe("an issue about the value itself")
structured-output.test.ts: ~ describe("asking for a value")
structured-output.test.ts: - describe("finding the value in the call")
structured-output.test.ts: ~ describe("when the answer is wrong")
structured-output.test.ts: + describe("finding the value in what the model said")
structured-output.ts: ~ class MalformedObjectError
structured-output.ts: ~ function correctionFor
structured-output.ts: ~ function payloadOf
structured-output.ts: ~ function requestFor
structured-output.ts: ~ function textOf
structured-output.ts: ~ interface ObjectRequest
structured-output.ts: ~ interface StandardIssue
structured-output.ts: ~ type Problem
structured-output.ts: + function closingOf
structured-output.ts: + function jsonIn
structured-output.ts: + type Located

## strategy=prompt

roles: core, example, test
structured-output-example.ts: ~ function extractOrder
structured-output.test.ts: ~ describe("an issue about the value itself")
structured-output.test.ts: ~ describe("asking for a value")
structured-output.test.ts: - describe("finding the value in the call")
structured-output.test.ts: ~ describe("when the answer is wrong")
structured-output.test.ts: + describe("finding the value in what the model said")
structured-output.ts: ~ class MalformedObjectError
structured-output.ts: ~ function correctionFor
structured-output.ts: ~ function payloadOf
structured-output.ts: ~ function requestFor
structured-output.ts: ~ function textOf
structured-output.ts: ~ interface ObjectRequest
structured-output.ts: ~ interface StandardIssue
structured-output.ts: ~ type Problem
structured-output.ts: + function closingOf
structured-output.ts: + function jsonIn
structured-output.ts: + type Located

## onInvalid=refuse

roles: core, example, test
structured-output-example.ts: ~ function extractOrder
structured-output.test.ts: ~ describe("an issue about the value itself")
structured-output.test.ts: ~ describe("asking for a value")
structured-output.test.ts: ~ describe("finding the value in the call")
structured-output.test.ts: ~ describe("when the answer is wrong")
structured-output.test.ts: ~ function ask
structured-output.test.ts: - function complaintIn
structured-output.test.ts: ~ import "./structured-output.js"#2
structured-output.ts: ~ class MalformedObjectError
structured-output.ts: ~ class SchemaViolationError
structured-output.ts: - function correctionFor
structured-output.ts: - function echoOf
structured-output.ts: ~ function generateObject
structured-output.ts: - function problemWith
structured-output.ts: - function refusalFor
structured-output.ts: - function sumOf
structured-output.ts: - function totalOf
structured-output.ts: ~ interface ObjectRequest
structured-output.ts: ~ interface StandardIssue
structured-output.ts: ~ interface StructuredResult
structured-output.ts: - type Problem

## includeTests=false

roles: test
-file structured-output.test.ts
