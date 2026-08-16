# chat-model-port

## provider=anthropic-messages

roles: binding, example, test
+file anthropic-chat-model-example.ts
+file anthropic-chat-model.test.ts
+file anthropic-chat-model.ts
-file openai-chat-model-example.ts
-file openai-chat-model.test.ts
-file openai-chat-model.ts

## streaming=false

roles: binding, core, example, test
chat-model-port.ts: - function sseEvents
chat-model-port.ts: - function textChunks
chat-model-port.ts: - function withoutCarriageReturn
chat-model-port.ts: - interface ByteStream
chat-model-port.ts: - interface ByteStreamReader
chat-model-port.ts: - interface SseEvent
chat-model-port.ts: - interface StreamingChatModel
chat-model-port.ts: ~ type JsonSchema
chat-model-port.ts: - type StreamPart
openai-chat-model-example.ts: ~ function replaying
openai-chat-model.test.ts: - describe("decoding a stream")
openai-chat-model.test.ts: - describe("framing a stream")
openai-chat-model.test.ts: ~ describe("the model over a transport")
openai-chat-model.test.ts: ~ function answering
openai-chat-model.test.ts: - function byteStream
openai-chat-model.test.ts: - function bytesOf
openai-chat-model.test.ts: - function chunksOf
openai-chat-model.test.ts: - function drain
openai-chat-model.test.ts: - function streamOf
openai-chat-model.test.ts: ~ import "./chat-model-port.js"
openai-chat-model.test.ts: ~ import "./chat-model-port.js"#2
openai-chat-model.test.ts: ~ import "./openai-chat-model.js"
openai-chat-model.test.ts: ~ import "vitest"
openai-chat-model.ts: ~ function createOpenAiChatModel
openai-chat-model.ts: - function decodeStream
openai-chat-model.ts: - function parseEvent
openai-chat-model.ts: - function toolCallParts
openai-chat-model.ts: ~ import "./chat-model-port.js"
openai-chat-model.ts: ~ import "./chat-model-port.js"#2
openai-chat-model.ts: ~ interface FetchResponse

## emitScope=core-only

roles: binding, example, test
+file chat-model-port-example.ts
+file chat-model-port.test.ts
-file openai-chat-model-example.ts
-file openai-chat-model.test.ts
-file openai-chat-model.ts

## emitScope=binding-only

refused: missing_required_option

## includeTests=false

roles: test
-file openai-chat-model.test.ts
